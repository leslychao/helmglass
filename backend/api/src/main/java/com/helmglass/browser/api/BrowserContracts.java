package com.helmglass.browser.api;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.UUID;

public final class BrowserContracts {
  private BrowserContracts() {}

  public record Open(
      @NotNull Long expectedVersion,
      @NotNull @Pattern(regexp = "TASK") String purpose,
      @NotNull @Pattern(regexp = "SAVE_ON_CLOSE|DISCARD_CHANGES") String savePolicy,
      UUID observedPreviousSessionId,
      boolean consentNewBrowser) {}

  public record TakeControl(
      @NotNull Long expectedVersion,
      @NotNull Long controlEpoch,
      @NotNull UUID controllerInstanceId,
      boolean privateLogin,
      boolean transferExistingController) {}

  public record ReleaseControl(
      @NotNull Long controlEpoch,
      @NotNull UUID controllerInstanceId,
      @NotNull @Pattern(regexp = "CONTINUE_IF_ALLOWED|KEEP_PAUSED") String intent) {}

  public record Renew(@NotNull Long controlEpoch, @NotNull UUID controllerInstanceId) {}

  public record View(
      UUID taskId,
      @NotNull Long expectedVersion,
      @NotNull UUID viewerInstanceId,
      UUID controllerInstanceId) {}

  public record InputTicket(@NotNull UUID controllerInstanceId, @NotNull Long controlEpoch) {}

  public record Navigation(
      @NotNull @Pattern(regexp = "BACK|FORWARD|RELOAD|GOTO") String action,
      @Size(max = 2048) String url,
      @NotNull Long expectedVersion,
      @NotNull Long controlEpoch,
      @NotNull Long pageEpoch,
      @NotNull UUID controllerInstanceId) {}

  public record Snapshot(
      @NotNull Long expectedVersion,
      @NotNull Long controlEpoch,
      @NotNull Long pageEpoch,
      @NotNull UUID controllerInstanceId) {}

  public record Save(
      @NotNull Long expectedVersion,
      @NotNull Long controlEpoch,
      @NotNull Long pageEpoch,
      @NotNull UUID controllerInstanceId,
      UUID expectedProfileVersion) {}

  public record SavePolicy(
      @NotNull Long expectedVersion,
      @NotNull Long expectedConnectionVersion,
      @NotNull @Pattern(regexp = "SAVE_ON_CLOSE|DISCARD_CHANGES") String policy) {}

  public record Close(
      @NotNull Long expectedVersion,
      @NotNull Long controlEpoch,
      @NotNull Long pageEpoch,
      @NotNull UUID controllerInstanceId,
      UUID expectedProfileVersion,
      @NotNull Boolean saveChanges) {}
}
