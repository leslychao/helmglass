package com.helmglass.artifact.domain;

import com.helmglass.api.DomainException;
import java.util.regex.Pattern;

/** One bounded HTTP byte range; multi-range responses are deliberately unsupported. */
public record ByteRange(long start, long end, long total, boolean partial) {
  private static final Pattern SYNTAX = Pattern.compile("bytes=([0-9]{0,19})-([0-9]{0,19})");

  public static ByteRange parse(String value, long total) {
    if (value == null) {
      return new ByteRange(0, total - 1, total, false);
    }
    var match = SYNTAX.matcher(value);
    if (!match.matches() || match.group(1).isEmpty() && match.group(2).isEmpty()) {
      throw invalid();
    }
    try {
      long start;
      long end;
      if (match.group(1).isEmpty()) {
        long suffix = Long.parseLong(match.group(2));
        if (suffix <= 0) {
          throw invalid();
        }
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = Long.parseLong(match.group(1));
        end = match.group(2).isEmpty() ? total - 1 : Math.min(total - 1, Long.parseLong(match.group(2)));
      }
      if (start >= total || start > end) {
        throw invalid();
      }
      return new ByteRange(start, end, total, true);
    } catch (NumberFormatException error) {
      throw invalid();
    }
  }

  public long length() {
    return end - start + 1;
  }

  public String requestHeader() {
    return "bytes=" + start + "-" + end;
  }

  public String responseHeader() {
    return "bytes " + start + "-" + end + "/" + total;
  }

  private static DomainException invalid() {
    return new DomainException(416, "RANGE_NOT_SATISFIABLE", "One valid byte range is required");
  }
}
