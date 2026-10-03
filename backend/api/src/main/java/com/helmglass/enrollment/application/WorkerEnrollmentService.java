package com.helmglass.enrollment.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.bootstrap.RuntimeSecrets;
import com.helmglass.enrollment.api.EnrollmentContracts.Request;
import com.helmglass.enrollment.api.EnrollmentContracts.Response;
import com.helmglass.enrollment.infrastructure.repository.EnrollmentRepository;
import com.helmglass.enrollment.infrastructure.repository.EnrollmentRepository.Enrollment;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import javax.security.auth.x500.X500Principal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.vault.VaultException;
import org.springframework.vault.core.VaultOperations;
import org.springframework.vault.support.Certificate;
import org.springframework.vault.support.VaultCertificateRequest;

/** Admission and boot ownership are checked before asking the restricted PKI role to sign. */
@Service
public class WorkerEnrollmentService {
  private record Reservation(UUID issuanceId, Response existing) {}
  private final RuntimeSecrets secrets;
  private final EnrollmentRepository repository;
  private final VaultOperations vault;
  private final TransactionTemplate transaction;
  private final int registrationLimit;

  public WorkerEnrollmentService(RuntimeSecrets secrets, EnrollmentRepository repository,
      VaultOperations vault, PlatformTransactionManager transactions,
      @Value("${helm.worker-registration-limit}") int registrationLimit) {
    if (registrationLimit < 1 || registrationLimit > 1000) {
      throw new IllegalArgumentException("Worker registration limit must be between 1 and 1000");
    }
    this.registrationLimit = registrationLimit;
    this.secrets = secrets;
    this.repository = repository;
    this.vault = vault;
    transaction = new TransactionTemplate(transactions);
    transaction.setTimeout(5);
  }

  public Response enroll(Request request, X509Certificate peer) {
    if (!secrets.installationId().equals(request.installationId())
        || !MessageDigest.isEqual(secrets.workerEnrollmentToken().getBytes(StandardCharsets.UTF_8),
            request.enrollmentToken().getBytes(StandardCharsets.UTF_8))) {
      throw new DomainException(403, "ENROLLMENT_DENIED", "Enrollment scope is invalid");
    }
    String digest = JsonSupport.sha256(request.csrPem());
    Reservation reservation = transaction.execute(status -> reserve(request, digest, peer));
    if (reservation == null) {
      throw new IllegalStateException("Enrollment reservation was not completed");
    }
    if (reservation.existing() != null) {
      return reservation.existing();
    }
    Certificate certificate;
    try {
      var options = VaultCertificateRequest.builder().commonName(commonName(request.workerId()))
          .format("pem")
          .excludeCommonNameFromSubjectAltNames()
          .withUriSubjectAltName(identityUri(request.workerId(), request.bootId()))
          .ttl(Duration.ofMinutes(15)).build();
      var signed = vault.opsForPki("helm-pki")
          .signCertificateRequest("browser-workers", request.csrPem(), options);
      certificate = signed.getRequiredData();
      checkCertificate(certificate.getX509Certificate(), request.workerId(), request.bootId());
    } catch (VaultException | CertificateException error) {
      // Do not return a Vault response or CSR in an HTTP problem. A pending reservation keeps
      // counting against admission after an unknown signing outcome.
      throw new DomainException(503, "WORKER_PKI_UNAVAILABLE", "Worker identity was not issued");
    }
    Instant expiresAt = certificate.getX509Certificate().getNotAfter().toInstant();
    String caPem = String.join("\n", certificate.getCaChain());
    if (caPem.isBlank()) {
      caPem = certificate.getIssuingCaCertificate();
    }
    String chain = caPem;
    boolean saved = Boolean.TRUE.equals(transaction.execute(status -> repository.complete(
        reservation.issuanceId(), certificate.getCertificate(), chain,
        certificate.getX509Certificate().getSerialNumber().toString(16), expiresAt)));
    if (!saved) {
      vault.opsForPki("helm-pki").revoke(certificate.getSerialNumber());
      throw DomainException.conflict("ENROLLMENT_SUPERSEDED", "The issuance was superseded");
    }
    return new Response(1, request.workerId(), request.bootId(), certificate.getCertificate(),
        chain, expiresAt);
  }

  /**
   * Revokes this installation's enrollments after the operator has stopped every worker.
   * Repeating the command before restarting the pool is safe; enrollment history is retained.
   */
  public int retireStoppedPool() {
    Integer retired = transaction.execute(status -> {
      repository.lockInstallation(secrets.installationId());
      return repository.revokeInstallation(secrets.installationId());
    });
    if (retired == null) {
      throw new IllegalStateException("Worker retirement was not completed");
    }
    return retired;
  }

  private Reservation reserve(Request request, String digest, X509Certificate peer) {
    repository.lockInstallation(secrets.installationId());
    Enrollment existing = repository.find(secrets.installationId(), request.workerId(),
        request.bootId()).orElse(null);
    Instant now = Instant.now();
    boolean renewal = false;
    if (existing != null) {
      if (existing.state().equals("REVOKED") || !existing.expiresAt().isAfter(now)
          || existing.capacity() != request.capacity()) {
        throw new DomainException(
            403, "ENROLLMENT_REVOKED", "Start with a new worker boot identity");
      }
      if (existing.state().equals("READY") && existing.csrDigest().equals(digest)
          && existing.expiresAt().isAfter(now.plusSeconds(120))) {
        return new Reservation(existing.issuanceId(), response(existing));
      }
      if (existing.state().equals("READY")) {
        authenticate(peer, request.workerId(), request.bootId());
        renewal = true;
      } else if (!existing.csrDigest().equals(digest)
          || existing.nextAttemptAt().isAfter(now) || existing.issuanceAttempts() >= 3) {
        throw DomainException.conflict(
            "ENROLLMENT_PENDING", "Wait for identity issuance reconciliation");
      }
    } else {
      if (repository.activeCount(secrets.installationId()) >= registrationLimit
          || repository.hasOtherLiveBoot(secrets.installationId(), request.workerId(),
              request.bootId())) {
        throw DomainException.conflict(
            "ENROLLMENT_CAPACITY", "Worker registration capacity is occupied");
      }
    }
    UUID issuanceId = UUID.randomUUID();
    repository.reserve(secrets.installationId(), request.workerId(), request.bootId(),
        request.capacity(), digest, issuanceId, renewal);
    return new Reservation(issuanceId, null);
  }

  /** Returns the hard channel deadline; callers must terminate tunnels at this instant. */
  public Instant authenticate(X509Certificate certificate, UUID workerId, UUID bootId) {
    if (certificate == null) {
      throw new DomainException(403, "WORKER_IDENTITY_REQUIRED", "Worker certificate is required");
    }
    try {
      checkCertificate(certificate, workerId, bootId);
    } catch (CertificateException error) {
      throw new DomainException(403, "WORKER_IDENTITY_INVALID", "Worker certificate is invalid");
    }
    Enrollment enrollment = repository.find(secrets.installationId(), workerId, bootId)
        .orElseThrow(() -> new DomainException(
            403, "WORKER_NOT_ENROLLED", "Worker is not enrolled"));
    if (enrollment.state().equals("REVOKED") || !enrollment.expiresAt().isAfter(Instant.now())
        || !certificate.getSerialNumber().toString(16).equals(enrollment.serialNumber())) {
      throw new DomainException(
          403, "WORKER_IDENTITY_REVOKED", "Worker identity is no longer active");
    }
    return certificate.getNotAfter().toInstant();
  }

  private void checkCertificate(X509Certificate certificate, UUID workerId, UUID bootId)
      throws CertificateException {
    certificate.checkValidity();
    if (!certificate.getSubjectX500Principal().getName(X500Principal.RFC2253)
        .equals("CN=" + commonName(workerId))) {
      throw new CertificateException("Worker certificate subject is outside its scope");
    }
    Collection<List<?>> alternatives = certificate.getSubjectAlternativeNames();
    String expected = identityUri(workerId, bootId);
    if (alternatives == null || alternatives.size() != 1
        || alternatives.stream().noneMatch(value -> value.size() == 2
            && Integer.valueOf(6).equals(value.getFirst()) && expected.equals(value.get(1)))) {
      throw new CertificateException("Worker certificate SAN is outside its scope");
    }
  }

  private static String commonName(UUID workerId) {
    return "browser-worker-" + workerId;
  }

  private String identityUri(UUID workerId, UUID bootId) {
    return "urn:helm-glass:" + secrets.installationId() + ":" + workerId + ":" + bootId;
  }

  private static Response response(Enrollment enrollment) {
    return new Response(1, enrollment.workerId(), enrollment.bootId(),
        enrollment.certificatePem(), enrollment.caPem(), enrollment.expiresAt());
  }
}
