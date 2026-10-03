package com.helmglass;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import com.helmglass.artifact.domain.PngHeader;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Arrays;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;

class PngHeaderTest {
  @Test
  void acceptsAnEncodedPngOnlyForItsAdmittedViewport() throws IOException {
    byte[] header = header();
    PngHeader.verify(header, 1280, 720);
    assertThatThrownBy(() -> PngHeader.verify(header, 720, 1280))
        .isInstanceOf(DomainException.class);
  }

  @Test
  void rejectsCorruptedOrTruncatedHeaders() throws IOException {
    byte[] header = header();
    header[25] ^= 1;
    assertThatThrownBy(() -> PngHeader.verify(header, 1280, 720))
        .isInstanceOf(DomainException.class);
    assertThatThrownBy(() -> PngHeader.verify(Arrays.copyOf(header, 20), 1280, 720))
        .isInstanceOf(DomainException.class);
  }

  private static byte[] header() throws IOException {
    try (var output = new ByteArrayOutputStream()) {
      assertThat(
              ImageIO.write(
                  new BufferedImage(1280, 720, BufferedImage.TYPE_INT_RGB), "png", output))
          .isTrue();
      return Arrays.copyOf(output.toByteArray(), PngHeader.BYTES);
    }
  }
}
