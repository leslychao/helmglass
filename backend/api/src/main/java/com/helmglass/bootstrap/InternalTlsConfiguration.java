package com.helmglass.bootstrap;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import org.apache.catalina.connector.Connector;
import org.apache.coyote.http11.Http11NioProtocol;
import org.apache.tomcat.util.net.SSLHostConfig;
import org.apache.tomcat.util.net.SSLHostConfigCertificate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
class InternalTlsConfiguration {
  @Bean
  WebServerFactoryCustomizer<TomcatServletWebServerFactory> internalTlsConnectors(
      @Value("${helm.internal-tls.certificate}") String certificate,
      @Value("${helm.internal-tls.private-key}") String privateKey,
      @Value("${helm.internal-tls.trust-certificate}") String trustCertificate)
      throws IOException, GeneralSecurityException {
    KeyStore trustStore = CertificateTrust.store(Files.readString(Path.of(trustCertificate)));
    return factory -> factory.addAdditionalConnectors(
        connector(8444, "optional", certificate, privateKey, trustStore),
        connector(8446, "required", certificate, privateKey, trustStore));
  }

  static Connector connector(int port, String clientAuthentication, String certificate,
      String privateKey, KeyStore trustStore) {
    Connector connector = new Connector(Http11NioProtocol.class.getName());
    connector.setPort(port);
    connector.setScheme("https");
    connector.setSecure(true);
    Http11NioProtocol protocol = (Http11NioProtocol) connector.getProtocolHandler();
    protocol.setSSLEnabled(true);
    protocol.setMaxThreads(64);
    protocol.setMaxConnections(256);
    protocol.setConnectionTimeout(5000);
    protocol.setMaxHttpRequestHeaderSize(16_384);
    SSLHostConfig host = new SSLHostConfig();
    // JSSE cannot perform TLS 1.3 optional client authentication. Enrollment and existing
    // workers share this listener, so they negotiate TLS 1.2 with initial client authentication.
    host.setProtocols(clientAuthentication.equals("optional") ? "TLSv1.2" : "TLSv1.3,+TLSv1.2");
    host.setCertificateVerification(clientAuthentication);
    host.setTrustStore(trustStore);
    SSLHostConfigCertificate identity = new SSLHostConfigCertificate(
        host, SSLHostConfigCertificate.Type.UNDEFINED);
    identity.setCertificateFile(certificate);
    identity.setCertificateKeyFile(privateKey);
    host.addCertificate(identity);
    protocol.addSslHostConfig(host);
    return connector;
  }
}
