package com.helmglass.bootstrap;

import java.net.URI;
import java.net.http.HttpClient;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.vault.authentication.AppRoleAuthentication;
import org.springframework.vault.authentication.AppRoleAuthenticationOptions;
import org.springframework.vault.authentication.LifecycleAwareSessionManager;
import org.springframework.vault.client.VaultClient;
import org.springframework.vault.client.VaultEndpoint;
import org.springframework.vault.core.VaultOperations;
import org.springframework.vault.core.VaultTemplate;

/** Owns one renewable AppRole session and its resources for the API process lifetime. */
final class VaultSession implements AutoCloseable {
  private final ThreadPoolTaskScheduler scheduler;
  private final HttpClient httpClient;
  private final LifecycleAwareSessionManager sessionManager;
  private final VaultTemplate operations;
  private final AtomicBoolean closed = new AtomicBoolean();

  VaultSession(BootstrapIdentity.VaultIdentity identity) throws GeneralSecurityException {
    httpClient = HttpClient.newBuilder().sslContext(CertificateTrust.context(identity.caPem()))
        .connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
    JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(httpClient);
    requestFactory.setReadTimeout(Duration.ofSeconds(5));
    VaultClient client = VaultClient.builder()
        .endpoint(VaultEndpoint.from(URI.create(identity.address())))
        .requestFactory(requestFactory).build();
    AppRoleAuthenticationOptions options = AppRoleAuthenticationOptions.builder()
        .roleId(AppRoleAuthenticationOptions.RoleId.provided(identity.roleId()))
        .secretId(AppRoleAuthenticationOptions.SecretId.provided(identity.secretId())).build();
    scheduler = new ThreadPoolTaskScheduler();
    scheduler.setPoolSize(1);
    scheduler.setThreadNamePrefix("vault-session-");
    scheduler.setDaemon(true);
    scheduler.initialize();
    sessionManager = new LifecycleAwareSessionManager(
        new AppRoleAuthentication(options, client), scheduler, client);
    operations = new VaultTemplate(client, sessionManager);
  }

  VaultOperations operations() {
    return operations;
  }

  @Override
  public void close() {
    if (closed.compareAndSet(false, true)) {
      try {
        sessionManager.destroy();
      } finally {
        scheduler.shutdown();
        httpClient.shutdownNow();
      }
    }
  }
}
