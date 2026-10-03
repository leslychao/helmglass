package com.helmglass.artifact.domain;

import com.helmglass.api.DomainException;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.zip.CRC32;

/** Validates a PNG header against the viewport admitted for the explicit screenshot. */
public final class PngHeader {
  public static final int BYTES = 33;
  private static final byte[] SIGNATURE = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};

  private PngHeader() {}

  public static void verify(byte[] header, int width, int height) {
    if (header.length != BYTES || !Arrays.equals(header, 0, 8, SIGNATURE, 0, 8)) {
      throw invalid();
    }
    ByteBuffer fields = ByteBuffer.wrap(header);
    CRC32 crc = new CRC32();
    crc.update(header, 12, 17);
    if (fields.getInt(8) != 13
        || fields.getInt(12) != 0x49484452
        || fields.getInt(16) != width
        || fields.getInt(20) != height
        || header[26] != 0
        || header[27] != 0
        || (header[28] != 0 && header[28] != 1)
        || crc.getValue() != Integer.toUnsignedLong(fields.getInt(29))) {
      throw invalid();
    }
  }

  private static DomainException invalid() {
    return new DomainException(
        422, "SCREENSHOT_FORMAT_INVALID", "PNG does not match the admitted viewport");
  }
}
