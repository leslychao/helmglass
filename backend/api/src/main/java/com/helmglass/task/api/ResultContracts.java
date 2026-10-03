package com.helmglass.task.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ResultContracts {
  private ResultContracts() {}

  public record Column(@NotNull @Size(min = 1, max = 100) String key,
      @NotNull @Size(min = 1, max = 200) String label, @NotNull String type) {}

  public record Section(@NotNull @Size(min = 1, max = 200) String title,
      @NotNull @Size(max = 16000) String text) {}

  public record Source(@NotNull @Size(min = 1, max = 200) String title,
      @NotNull @Size(min = 1, max = 2048) String url) {}

  public record Publish(@NotNull Long expectedTaskVersion, @NotNull Long instructionRevision,
      UUID continuationClaimId, @NotNull @Size(max = 16000) String conclusion,
      @NotNull @Size(max = 100) List<@NotNull @Size(max = 16000) String> limitations,
      @NotNull @Size(max = 100) List<@NotNull @Size(max = 16000) String> missing,
      @NotNull @Size(max = 100) List<@Valid @NotNull Column> columns,
      @NotNull @Size(max = 10000) List<@NotNull Map<String, Object>> rows,
      @NotNull Map<String, Object> coverage,
      @NotNull @Size(max = 100) List<@NotNull UUID> artifactIds,
      @Size(max = 100) List<@Valid @NotNull Section> sections,
      @Size(max = 100) List<@Valid @NotNull Source> sources) {
    public Publish {
      sections = sections == null ? List.of() : List.copyOf(sections);
      sources = sources == null ? List.of() : List.copyOf(sources);
    }
  }
}
