package com.helmglass.artifact.infrastructure;

import com.helmglass.api.DomainException;
import java.io.ByteArrayInputStream;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.ChecksumAlgorithm;
import software.amazon.awssdk.services.s3.model.ChecksumType;
import software.amazon.awssdk.services.s3.model.CompletedMultipartUpload;
import software.amazon.awssdk.services.s3.model.CompletedPart;

/** SDK multipart transport. Durable part ownership and retry decisions belong to ArtifactService. */
@Component
public class MultipartStorage {
  public record Part(int number, long size, String sha256, String etag) {}
  public record Pending(String key, String uploadId) {}
  public record Inventory(List<Pending> uploads, String keyMarker, String uploadIdMarker) {}
  private final S3Client s3;

  public MultipartStorage(S3Client s3) {
    this.s3 = s3;
  }

  public String create(String bucket, String key, String mime, String sha256) {
    return s3.createMultipartUpload(request -> request.bucket(bucket).key(key).contentType(mime)
        .checksumAlgorithm(ChecksumAlgorithm.SHA256).checksumType(ChecksumType.COMPOSITE)
        .metadata(Map.of("sha256", sha256))).uploadId();
  }

  public List<Pending> pending(String bucket, String key) {
    Inventory result = inventory(bucket, key, null, null);
    if (result.keyMarker() != null) {
      throw new DomainException(503, "ARTIFACT_UPLOAD_LIMIT", "Multipart inventory is incomplete");
    }
    return result.uploads().stream().filter(upload -> upload.key().equals(key)).toList();
  }

  public Inventory inventory(String bucket, String prefix, String keyMarker, String uploadMarker) {
    var result = s3.listMultipartUploads(request -> request.bucket(bucket).prefix(prefix)
        .maxUploads(100).keyMarker(keyMarker).uploadIdMarker(uploadMarker));
    boolean truncated = Boolean.TRUE.equals(result.isTruncated());
    if (truncated && result.nextKeyMarker() == null) {
      throw new DomainException(503, "ARTIFACT_INVENTORY_INVALID", "Storage inventory has no cursor");
    }
    return new Inventory(result.uploads().stream()
        .map(upload -> new Pending(upload.key(), upload.uploadId())).toList(),
        truncated ? result.nextKeyMarker() : null,
        truncated ? result.nextUploadIdMarker() : null);
  }

  public Part upload(String bucket, String key, String uploadId, int number, byte[] bytes,
      String sha256) {
    var result = s3.uploadPart(request -> request.bucket(bucket).key(key).uploadId(uploadId)
        .partNumber(number).contentLength((long) bytes.length).checksumSHA256(base64(sha256)),
        RequestBody.fromInputStream(new ByteArrayInputStream(bytes), bytes.length));
    if (!base64(sha256).equals(result.checksumSHA256())) {
      throw new DomainException(503, "ARTIFACT_PART_UNVERIFIED", "Storage part checksum is unverified");
    }
    return new Part(number, bytes.length, sha256, result.eTag());
  }

  public List<Part> parts(String bucket, String key, String uploadId) {
    var result = s3.listParts(request -> request.bucket(bucket).key(key).uploadId(uploadId)
        .maxParts(100));
    if (Boolean.TRUE.equals(result.isTruncated())) {
      throw new DomainException(503, "ARTIFACT_PART_LIMIT", "Stored part inventory exceeds the limit");
    }
    return result.parts().stream().map(part -> {
      if (part.checksumSHA256() == null) {
        throw new DomainException(503, "ARTIFACT_PART_UNVERIFIED", "Storage part checksum is missing");
      }
      String digest = HexFormat.of().formatHex(Base64.getDecoder().decode(part.checksumSHA256()));
      return new Part(part.partNumber(), part.size(), digest, part.eTag());
    }).toList();
  }

  public void complete(String bucket, String key, String uploadId, List<Part> parts) {
    var completed = parts.stream().map(part -> CompletedPart.builder().partNumber(part.number())
        .eTag(part.etag()).checksumSHA256(base64(part.sha256())).build()).toList();
    s3.completeMultipartUpload(request -> request.bucket(bucket).key(key).uploadId(uploadId)
        .ifNoneMatch("*").multipartUpload(CompletedMultipartUpload.builder().parts(completed).build()));
  }

  public void abort(String bucket, String key, String uploadId) {
    s3.abortMultipartUpload(request -> request.bucket(bucket).key(key).uploadId(uploadId));
  }

  private static String base64(String checksum) {
    return Base64.getEncoder().encodeToString(HexFormat.of().parseHex(checksum));
  }
}
