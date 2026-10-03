package com.helmglass.bootstrap;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.Collection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;

/** Builds a service trust boundary from its protected PEM bundle, retaining hostname validation. */
public final class CertificateTrust {
  private CertificateTrust() {}

  public static SSLContext context(String caPem) throws GeneralSecurityException {
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(null, managers(caPem), null);
    return context;
  }

  public static TrustManager[] managers(String caPem) throws GeneralSecurityException {
    TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
    factory.init(store(caPem));
    return factory.getTrustManagers();
  }

  public static KeyStore store(String caPem) throws GeneralSecurityException {
    Collection<? extends Certificate> certificates = CertificateFactory.getInstance("X.509")
        .generateCertificates(new ByteArrayInputStream(caPem.getBytes(StandardCharsets.US_ASCII)));
    if (certificates.isEmpty()) {
      throw new GeneralSecurityException("The trust bundle contains no certificates");
    }
    KeyStore trustStore = KeyStore.getInstance(KeyStore.getDefaultType());
    try {
      trustStore.load(null, null);
    } catch (IOException error) {
      throw new GeneralSecurityException("Cannot initialize the trust store", error);
    }
    int index = 0;
    for (Certificate certificate : certificates) {
      trustStore.setCertificateEntry("ca-" + index++, certificate);
    }
    return trustStore;
  }
}
