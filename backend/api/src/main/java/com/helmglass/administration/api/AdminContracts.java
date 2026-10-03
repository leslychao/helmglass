package com.helmglass.administration.api;

import com.helmglass.api.PageQuery;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

public final class AdminContracts {
  private AdminContracts() {}

  public record BrowserQuery(PageQuery workers, PageQuery allocations, PageQuery queue) {
    public static BrowserQuery from(MultiValueMap<String, String> parameters) {
      return new BrowserQuery(
          page(parameters, "workers."),
          page(parameters, "allocations."),
          page(parameters, "queue."));
    }

    private static PageQuery page(MultiValueMap<String, String> parameters, String prefix) {
      var selected = new LinkedMultiValueMap<String, String>();
      parameters.forEach(
          (name, values) -> {
            if (name.startsWith(prefix)) {
              selected.put(name.substring(prefix.length()), values);
            }
          });
      return PageQuery.from(selected);
    }
  }

  public record Reason(@NotNull Long expectedVersion, @NotBlank @Size(max = 1000) String reason) {}

  public record Stop(@NotBlank @Size(max = 1000) String reason) {}

  public record Admission(
      @NotNull Long expectedVersion,
      @NotBlank @Size(max = 1000) String reason,
      boolean acceptingAllocations) {}

  public record Limits(
      @NotNull Long expectedVersion,
      @NotBlank @Size(max = 1000) String reason,
      @NotNull @Pattern(regexp = "STANDARD|CUSTOM|POOL") String browserMode,
      @Min(1) Integer browserCustom,
      @NotNull @Pattern(regexp = "UNLIMITED|CUSTOM") String queuedMode,
      @Min(0) Integer queuedCustom) {}
}
