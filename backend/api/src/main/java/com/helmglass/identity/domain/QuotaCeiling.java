package com.helmglass.identity.domain;

/** An absent ceiling is unbounded; a personal preference can only reduce assigned capacity. */
public record QuotaCeiling(Integer assigned, Integer personal) {
  public static QuotaCeiling browsers(String mode, Integer custom, int standard, Integer personal) {
    Integer assigned =
        switch (mode) {
          case "STANDARD" -> standard;
          case "CUSTOM" -> custom;
          case "POOL" -> null;
          default -> throw new IllegalArgumentException("Unknown browser quota mode");
        };
    return new QuotaCeiling(assigned, personal);
  }

  public static QuotaCeiling queued(String mode, Integer custom, Integer personal) {
    Integer assigned =
        switch (mode) {
          case "CUSTOM" -> custom;
          case "UNLIMITED" -> null;
          default -> throw new IllegalArgumentException("Unknown waiting-task quota mode");
        };
    return new QuotaCeiling(assigned, personal);
  }

  public Integer effective() {
    if (assigned == null) {
      return personal;
    }
    return personal == null ? assigned : Math.min(assigned, personal);
  }

  public boolean personalFitsAssignment() {
    return personal == null || assigned == null || personal <= assigned;
  }
}
