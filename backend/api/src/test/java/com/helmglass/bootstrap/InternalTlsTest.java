package com.helmglass.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.time.Duration;
import java.util.Base64;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import org.apache.catalina.connector.Connector;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;

class InternalTlsTest {
  @TempDir
  Path directory;

  @Test
  void enrollmentAcceptsServerAuthWhileMcpRequiresTrustedClientCertificate() throws Exception {
    KeyStore identity = createIdentity();
    Certificate certificate = identity.getCertificate("fixture");
    String certificatePem = pem("CERTIFICATE", certificate.getEncoded());
    Path certificatePath = directory.resolve("certificate.pem");
    Path keyPath = directory.resolve("key.pem");
    Files.writeString(certificatePath, certificatePem);
    Files.writeString(keyPath, pem("PRIVATE KEY", identity.getKey("fixture",
        "fixture-password".toCharArray()).getEncoded()));
    KeyStore trust = CertificateTrust.store(certificatePem);
    Connector worker = InternalTlsConfiguration.connector(0, "optional",
        certificatePath.toString(), keyPath.toString(), trust);
    Connector mcp = InternalTlsConfiguration.connector(0, "required",
        certificatePath.toString(), keyPath.toString(), trust);
    TomcatServletWebServerFactory factory = new TomcatServletWebServerFactory(0);
    factory.setBaseDirectory(directory.resolve("tomcat").toFile());
    factory.addAdditionalConnectors(worker, mcp);
    var server = factory.getWebServer(context -> context.addServlet("probe", new HttpServlet() {
      @Override
      protected void doGet(HttpServletRequest request, HttpServletResponse response)
          throws IOException {
        response.getWriter().write(request.getAttribute("jakarta.servlet.request.X509Certificate")
            == null ? "server-auth" : "mutual-auth");
      }
    }).addMapping("/probe"));
    try {
      server.start();
      try (HttpClient serverAuth = client(trust, null);
          HttpClient mutualAuth = client(trust, identity);
          HttpClient untrusted = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
              .build()) {
        assertThat(read(serverAuth, worker.getLocalPort())).isEqualTo("server-auth");
        assertThat(read(mutualAuth, worker.getLocalPort())).isEqualTo("mutual-auth");
        assertThat(read(mutualAuth, mcp.getLocalPort())).isEqualTo("mutual-auth");
        assertThatThrownBy(() -> read(serverAuth, mcp.getLocalPort())).isInstanceOf(IOException.class);
        assertThatThrownBy(() -> read(untrusted, worker.getLocalPort())).isInstanceOf(IOException.class);
      }
    } finally {
      server.stop();
      server.destroy();
    }
  }

  private KeyStore createIdentity() throws Exception {
    Path store = directory.resolve("identity.p12");
    Path executable = Path.of(System.getProperty("java.home"), "bin", "keytool");
    Process process = new ProcessBuilder(executable.toString(), "-genkeypair", "-noprompt",
        "-alias", "fixture", "-keyalg", "RSA", "-keysize", "2048", "-validity", "1",
        "-dname", "CN=localhost", "-ext", "SAN=dns:localhost", "-ext",
        "EKU=serverAuth,clientAuth", "-storetype", "PKCS12", "-keystore", store.toString(),
        "-storepass", "fixture-password").redirectErrorStream(true)
        .redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
    if (!process.waitFor(30, TimeUnit.SECONDS)) {
      process.destroyForcibly();
      throw new IllegalStateException("Test certificate generation timed out");
    }
    assertThat(process.exitValue()).isZero();
    KeyStore result = KeyStore.getInstance("PKCS12");
    try (InputStream input = Files.newInputStream(store)) {
      result.load(input, "fixture-password".toCharArray());
    }
    return result;
  }

  private static HttpClient client(KeyStore trust, KeyStore identity) throws Exception {
    TrustManagerFactory trustManagers = TrustManagerFactory.getInstance(
        TrustManagerFactory.getDefaultAlgorithm());
    trustManagers.init(trust);
    KeyManagerFactory keyManagers = KeyManagerFactory.getInstance(
        KeyManagerFactory.getDefaultAlgorithm());
    if (identity != null) {
      keyManagers.init(identity, "fixture-password".toCharArray());
    }
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(identity == null ? null : keyManagers.getKeyManagers(),
        trustManagers.getTrustManagers(), new SecureRandom());
    return HttpClient.newBuilder().sslContext(context).connectTimeout(Duration.ofSeconds(2)).build();
  }

  private static String read(HttpClient client, int port) throws IOException, InterruptedException {
    return client.send(HttpRequest.newBuilder(URI.create("https://localhost:" + port + "/probe"))
        .timeout(Duration.ofSeconds(3)).GET().build(), HttpResponse.BodyHandlers.ofString()).body();
  }

  private static String pem(String type, byte[] bytes) {
    return "-----BEGIN " + type + "-----\n"
        + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(bytes)
        + "\n-----END " + type + "-----\n";
  }
}
