package com.helmglass.artifact.infrastructure;

import java.io.InputStream;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import software.amazon.awssdk.services.s3.model.ObjectIdentifier;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.ChecksumMode;
import software.amazon.awssdk.services.s3.model.GetObjectResponse;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;

/** Private object transport. Object ownership and publication belong to the calling owner. */
@Component
public class ObjectStorage {
  public record ObjectMetadata(long size, String sha256) {}
  private final S3Client s3;

  public ObjectStorage(S3Client s3) {
    this.s3 = s3;
  }

  public void putImmutable(String bucket, String key, InputStream bytes, long length, String sha256,
      String mime) {
    if (length < 1 || !sha256.matches("[a-f0-9]{64}")) {
      throw new IllegalArgumentException("Object length and checksum are required");
    }
    String checksum = Base64.getEncoder().encodeToString(HexFormat.of().parseHex(sha256));
    s3.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentLength(length)
        .contentType(mime).checksumSHA256(checksum).ifNoneMatch("*")
        .metadata(Map.of("sha256", sha256)).build(), RequestBody.fromInputStream(bytes, length));
  }

  public Optional<ObjectMetadata> metadata(String bucket, String key) {
    try {
      var object = s3.headObject(HeadObjectRequest.builder().bucket(bucket).key(key)
          .checksumMode(ChecksumMode.ENABLED).build());
      String checksum = object.checksumSHA256();
      // Multipart SHA-256 can be composite. It is never a digest of the complete byte stream.
      if ("COMPOSITE".equals(object.checksumTypeAsString())) {
        checksum = null;
      }
      return Optional.of(new ObjectMetadata(object.contentLength(),
          checksum == null ? null : HexFormat.of().formatHex(Base64.getDecoder().decode(checksum))));
    } catch (NoSuchKeyException error) {
      return Optional.empty();
    } catch (S3Exception error) {
      if (error.statusCode() == 404) {
        return Optional.empty();
      }
      throw error;
    }
  }

  public ResponseInputStream<GetObjectResponse> open(String bucket, String key) {
    return s3.getObject(request -> request.bucket(bucket).key(key).checksumMode(ChecksumMode.ENABLED));
  }

  public ResponseInputStream<GetObjectResponse> open(String bucket, String key, String range) {
    return s3.getObject(request -> request.bucket(bucket).key(key).range(range));
  }

  public void delete(String bucket, String key) {
    s3.deleteObject(request -> request.bucket(bucket).key(key));
  }

  /** Deletes a bounded page of one user's versions and uploads, then verifies the prefix. */
  public boolean purgeUserBatch(String bucket, UUID userId) {
    if (!Set.of("hg-artifacts", "hg-browser-profiles", "hg-staging").contains(bucket)) {
      throw new IllegalArgumentException("Unsupported private bucket");
    }
    String prefix = "u/" + userId + "/";
    var versions = s3.listObjectVersions(request -> request.bucket(bucket).prefix(prefix).maxKeys(100));
    var objects = new java.util.ArrayList<ObjectIdentifier>();
    for (var version : versions.versions()) {
      objects.add(ObjectIdentifier.builder().key(version.key()).versionId(version.versionId()).build());
    }
    for (var marker : versions.deleteMarkers()) {
      objects.add(ObjectIdentifier.builder().key(marker.key()).versionId(marker.versionId()).build());
    }
    if (!objects.isEmpty()) {
      var deleted = s3.deleteObjects(request -> request.bucket(bucket)
          .delete(value -> value.objects(objects).quiet(true)));
      if (!deleted.errors().isEmpty()) {
        throw new IllegalStateException("Private object deletion has unconfirmed items");
      }
    }
    var uploads = s3.listMultipartUploads(request -> request.bucket(bucket).prefix(prefix).maxUploads(100));
    for (var upload : uploads.uploads()) {
      try {
        s3.abortMultipartUpload(request -> request.bucket(bucket).key(upload.key()).uploadId(upload.uploadId()));
      } catch (S3Exception error) {
        if (error.statusCode() != 404) {
          throw error;
        }
      }
    }
    var remaining = s3.listObjectVersions(request -> request.bucket(bucket).prefix(prefix).maxKeys(1));
    var pending = s3.listMultipartUploads(request -> request.bucket(bucket).prefix(prefix).maxUploads(1));
    return remaining.versions().isEmpty() && remaining.deleteMarkers().isEmpty() && pending.uploads().isEmpty();
  }

  public record ObjectPage(List<String> keys, String nextCursor) {}

  public ObjectPage list(String bucket, String prefix, String cursor) {
    var page = s3.listObjectsV2(request -> request.bucket(bucket).prefix(prefix)
        .continuationToken(cursor).maxKeys(100));
    return new ObjectPage(page.contents().stream().map(value -> value.key()).toList(),
        page.isTruncated() ? page.nextContinuationToken() : null);
  }
}
