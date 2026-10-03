package com.helmglass.identity.application;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.helmglass.api.DomainException;
import com.helmglass.identity.infrastructure.KeycloakSessionClient;
import com.helmglass.identity.infrastructure.repository.LogoutRepository;
import com.helmglass.identity.infrastructure.repository.LogoutRepository.SessionLogout;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class LogoutServiceTest {

  @Mock private LogoutRepository logouts;
  @Mock private KeycloakSessionClient keycloak;
  private LogoutService service;

  @BeforeEach
  void setUp() {
    service = new LogoutService(logouts, keycloak);
  }

  @AfterEach
  void close() {
    service.close();
  }

  @Test
  void endsTheProviderSessionBeforeReportingLogoutComplete() {
    var operation = new SessionLogout(UUID.randomUUID(), "provider-session", "PENDING");
    when(logouts.find(operation.id())).thenReturn(Optional.of(operation));

    assertTrue(service.finishProviderSession(operation.id()));

    verify(keycloak).logoutSession(operation.sid());
    verify(logouts).completed(operation.id());
    verify(logouts, never()).retry(operation.id());
  }

  @Test
  void providerFailureRemainsPendingForTheExistingRecoveryWorker() {
    var operation = new SessionLogout(UUID.randomUUID(), "provider-session", "PENDING");
    when(logouts.find(operation.id())).thenReturn(Optional.of(operation));
    doThrow(new DomainException(503, "IDENTITY_PROVIDER_UNAVAILABLE", "Unavailable"))
        .doNothing()
        .when(keycloak)
        .logoutSession(operation.sid());

    assertFalse(service.finishProviderSession(operation.id()));
    verify(logouts).retry(operation.id());
    verify(logouts, never()).completed(operation.id());

    when(logouts.pending()).thenReturn(List.of(operation));
    service.cleanSessions();
    verify(logouts).completed(operation.id());
  }
}
