package ru.helmglass.api.accounts;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.FileImageInputStream;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import ru.helmglass.api.ApiException;

/** Validates bounded uploaded portraits without trusting names or declared content types. */
@Component
public class ProfileImage {
  public static final int MAX_BYTES = 5 * 1024 * 1024;
  private static final long MAX_PIXELS = 16_777_216;
  private static final Map<String, String> CONTENT_TYPES =
      Map.of("png", "image/png", "jpeg", "image/jpeg", "webp", "image/webp");
  private final Semaphore decoder = new Semaphore(1);
  private final Path directory;

  public ProfileImage(@Value("${helm.artifact-directory}") String artifactDirectory) {
    directory = Path.of(artifactDirectory).resolve("profiles");
  }

  public Upload validate(UUID owner, InputStream source, long declaredSize, String declaredType)
      throws IOException {
    if (declaredSize < 1 || declaredSize > MAX_BYTES) {
      throw ApiException.invalid("file", "Выберите фотографию размером не более 5 МиБ.");
    }
    if (!CONTENT_TYPES.containsValue(declaredType == null ? "" : declaredType)) {
      throw ApiException.invalid("file", "Поддерживаются фотографии PNG, JPEG и WebP.");
    }
    if (!decoder.tryAcquire()) {
      throw new ApiException(
          HttpStatus.TOO_MANY_REQUESTS,
          "IMAGE_BUSY",
          "Другая фотография проверяется. Повторите позже.");
    }
    Path temporary = null;
    try {
      UUID id = UUID.randomUUID();
      Path ownerDirectory = directory.resolve(owner.toString());
      Files.createDirectories(ownerDirectory);
      temporary = ownerDirectory.resolve(id + ".part");
      MessageDigest digest = sha256();
      long copied = 0;
      try (var input = new DigestInputStream(source, digest);
          var output = Files.newOutputStream(temporary)) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
          copied += count;
          if (copied > MAX_BYTES) {
            throw ApiException.invalid("file", "Размер фотографии превышает 5 МиБ.");
          }
          output.write(buffer, 0, count);
        }
      }
      if (copied != declaredSize) {
        throw ApiException.invalid("file", "Фотография передана не полностью.");
      }
      validatePixels(temporary, declaredType);
      Upload upload =
          new Upload(
              id,
              temporary,
              ownerDirectory.resolve(id.toString()),
              declaredType,
              (int) copied,
              HexFormat.of().formatHex(digest.digest()));
      temporary = null;
      return upload;
    } finally {
      decoder.release();
      if (temporary != null) {
        Files.deleteIfExists(temporary);
      }
    }
  }

  public Path path(UUID owner, UUID image) {
    return directory.resolve(owner.toString()).resolve(image.toString());
  }

  /** Called under the account row lock, so a newly installed image cannot race cleanup. */
  public boolean cleanup(UUID owner, UUID current, boolean purging) throws IOException {
    Path ownerDirectory = directory.resolve(owner.toString());
    if (!Files.exists(ownerDirectory)) {
      return true;
    }
    int removed = 0;
    boolean complete = true;
    try (var files = Files.newDirectoryStream(ownerDirectory)) {
      for (Path file : files) {
        String name = file.getFileName().toString();
        boolean temporary = name.endsWith(".part");
        String identifier = temporary ? name.substring(0, name.length() - 5) : name;
        UUID id;
        try {
          id = UUID.fromString(identifier);
        } catch (IllegalArgumentException exception) {
          complete = false;
          continue;
        }
        if (!purging
            && (id.equals(current)
                || temporary
                    && Files.getLastModifiedTime(file)
                        .toInstant()
                        .isAfter(Instant.now().minus(1, ChronoUnit.HOURS)))) {
          continue;
        }
        if (removed == 100) {
          return false;
        }
        Files.deleteIfExists(file);
        removed++;
      }
    }
    if (purging && complete) {
      Files.deleteIfExists(ownerDirectory);
    }
    return complete;
  }

  private static void validatePixels(Path file, String declaredType) throws IOException {
    try (var input = new FileImageInputStream(file.toFile())) {
      var readers = ImageIO.getImageReaders(input);
      if (!readers.hasNext()) {
        throw invalidImage();
      }
      ImageReader reader = readers.next();
      try {
        String format = reader.getFormatName().toLowerCase(Locale.ROOT);
        if (!declaredType.equals(CONTENT_TYPES.get(format))) {
          throw invalidImage();
        }
        reader.setInput(input, true, true);
        int width = reader.getWidth(0);
        int height = reader.getHeight(0);
        if (width < 1 || height < 1 || (long) width * height > MAX_PIXELS) {
          throw ApiException.invalid(
              "file", "Разрешение фотографии должно быть не более 16 мегапикселей.");
        }
        reader.addIIOReadWarningListener(
            (ignored, warning) -> {
              throw invalidImage();
            });
        var pixels = reader.read(0);
        if (pixels == null) {
          throw invalidImage();
        }
        pixels.flush();
      } catch (IOException | IllegalArgumentException exception) {
        throw invalidImage();
      } finally {
        reader.dispose();
      }
    }
  }

  private static ApiException invalidImage() {
    return ApiException.invalid(
        "file", "Не удалось прочитать фотографию. Выберите корректный PNG, JPEG или WebP.");
  }

  private static MessageDigest sha256() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
  }

  public record Upload(
      UUID id, Path path, Path destination, String contentType, int sizeBytes, String sha256)
      implements AutoCloseable {
    public void install() throws IOException {
      Files.move(path, destination, StandardCopyOption.ATOMIC_MOVE);
    }

    @Override
    public void close() throws IOException {
      Files.deleteIfExists(path);
    }
  }
}
