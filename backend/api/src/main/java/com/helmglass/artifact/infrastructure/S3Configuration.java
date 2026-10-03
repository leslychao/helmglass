package com.helmglass.artifact.infrastructure;

import com.helmglass.bootstrap.CertificateTrust;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.http.apache5.Apache5HttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;

@Configuration(proxyBeanMethods = false)
public class S3Configuration {
  @Bean(destroyMethod = "close")
  S3Client s3Client(
      @Value("${helm.s3.endpoint}") URI endpoint,
      @Value("${helm.s3.access-key}") String accessKey,
      @Value("${helm.s3.secret-key}") String secretKey,
      @Value("${helm.internal-tls.trust-certificate}") Path trustFile)
      throws IOException, GeneralSecurityException {
    if (endpoint.getHost() == null
        || endpoint.getUserInfo() != null
        || !"https".equals(endpoint.getScheme())
        || endpoint.getRawQuery() != null
        || endpoint.getRawFragment() != null
        || !(endpoint.getPath().isEmpty() || "/".equals(endpoint.getPath()))) {
      throw new IllegalArgumentException("Invalid internal S3 endpoint");
    }
    var trustManagers = CertificateTrust.managers(Files.readString(trustFile));
    return S3Client.builder()
        .endpointOverride(endpoint)
        .region(Region.US_EAST_1)
        .forcePathStyle(true)
        .httpClientBuilder(
            Apache5HttpClient.builder()
                .tlsTrustManagersProvider(() -> trustManagers)
                .connectionTimeout(Duration.ofSeconds(3))
                .socketTimeout(Duration.ofSeconds(30))
                .connectionAcquisitionTimeout(Duration.ofSeconds(3))
                .maxConnections(16))
        .credentialsProvider(
            StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey)))
        .overrideConfiguration(
            configuration ->
                configuration
                    .apiCallTimeout(Duration.ofSeconds(120))
                    .apiCallAttemptTimeout(Duration.ofSeconds(120))
                    .retryStrategy(retries -> retries.maxAttempts(1)))
        .build();
  }
}
