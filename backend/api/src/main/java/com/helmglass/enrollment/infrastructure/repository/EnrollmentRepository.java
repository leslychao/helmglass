package com.helmglass.enrollment.infrastructure.repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class EnrollmentRepository {
  private final JdbcClient jdbc;

  public EnrollmentRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Enrollment(
      String installationId,
      UUID workerId,
      UUID bootId,
      int capacity,
      String csrDigest,
      UUID issuanceId,
      String state,
      String certificatePem,
      String caPem,
      String serialNumber,
      Instant expiresAt,
      Instant nextAttemptAt,
      int issuanceAttempts) {}

  public void lockInstallation(String installationId) {
    jdbc.sql("SELECT pg_advisory_xact_lock(hashtextextended(:installation, 0))")
        .param("installation", installationId)
        .query()
        .singleRow();
  }

  public Optional<Enrollment> find(String installation, UUID workerId, UUID bootId) {
    return jdbc.sql(
            """
            SELECT installation_id, worker_id, boot_id, capacity, csr_digest, issuance_id, state,
              certificate_pem, ca_pem, serial_number, expires_at, next_attempt_at, issuance_attempts
            FROM worker_enrollments
            WHERE installation_id=:installation AND worker_id=:worker AND boot_id=:boot
            """)
        .param("installation", installation)
        .param("worker", workerId)
        .param("boot", bootId)
        .query(Enrollment.class)
        .optional();
  }

  public long activeCount(String installation) {
    return jdbc.sql(
            """
            SELECT count(*) FROM worker_enrollments
            WHERE installation_id=:installation AND expires_at>now() AND state<>'REVOKED'
            """)
        .param("installation", installation)
        .query(Long.class)
        .single();
  }

  public int revokeInstallation(String installation) {
    return jdbc.sql(
            """
            UPDATE worker_enrollments SET state='REVOKED'
            WHERE installation_id=:installation AND state<>'REVOKED'
            """)
        .param("installation", installation)
        .update();
  }

  public int revokeBoot(String installation, UUID workerId, UUID bootId) {
    return jdbc.sql(
            """
            UPDATE worker_enrollments SET state='REVOKED'
            WHERE installation_id=:installation AND worker_id=:worker AND boot_id=:boot
              AND state<>'REVOKED'
            """)
        .param("installation", installation)
        .param("worker", workerId)
        .param("boot", bootId)
        .update();
  }

  public boolean hasOtherLiveBoot(String installation, UUID workerId, UUID bootId) {
    return jdbc.sql(
            """
            SELECT EXISTS(SELECT 1 FROM worker_enrollments
            WHERE installation_id=:installation AND worker_id=:worker AND boot_id<>:boot
              AND expires_at>now() AND state<>'REVOKED')
            """)
        .param("installation", installation)
        .param("worker", workerId)
        .param("boot", bootId)
        .query(Boolean.class)
        .single();
  }

  public void reserve(
      String installation,
      UUID workerId,
      UUID bootId,
      int capacity,
      String csrDigest,
      UUID issuanceId,
      boolean renewal) {
    jdbc.sql(
            """
            INSERT INTO worker_enrollments(installation_id,worker_id,boot_id,capacity,csr_digest,
              issuance_id,state,expires_at,next_attempt_at)
            VALUES(:installation,:worker,:boot,:capacity,:digest,:issuance,'PENDING',
              now()+interval '15 minutes',now()+interval '15 seconds')
            ON CONFLICT(installation_id,worker_id,boot_id) DO UPDATE SET
              csr_digest=:digest,issuance_id=:issuance,state='PENDING',
              next_attempt_at=now()+interval '15 seconds',
              issuance_attempts=CASE WHEN :renewal THEN 1 ELSE worker_enrollments.issuance_attempts+1 END
            """)
        .param("installation", installation)
        .param("worker", workerId)
        .param("boot", bootId)
        .param("capacity", capacity)
        .param("digest", csrDigest)
        .param("issuance", issuanceId)
        .param("renewal", renewal)
        .update();
  }

  public boolean complete(
      UUID issuanceId,
      String certificatePem,
      String caPem,
      String serialNumber,
      Instant expiresAt) {
    return jdbc.sql(
                """
                UPDATE worker_enrollments SET state='READY',certificate_pem=:certificate,ca_pem=:ca,
                  serial_number=:serial,expires_at=:expires
                WHERE issuance_id=:issuance AND state='PENDING'
                """)
            .param("certificate", certificatePem)
            .param("ca", caPem)
            .param("serial", serialNumber)
            .param("expires", Timestamp.from(expiresAt))
            .param("issuance", issuanceId)
            .update()
        == 1;
  }
}
