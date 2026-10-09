package ru.helmglass.api.audio;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.helmglass.api.auth.Identity;

@RestController
public class AudioController {
  private final AudioAnalysisService analyses;
  private final Identity identity;
  private final byte[] token;

  public AudioController(
      AudioAnalysisService analyses,
      Identity identity,
      @Value("${helm.audio-token}") String token) {
    if (token.length() < 32) {
      throw new IllegalArgumentException("AUDIO_TOKEN is too short");
    }
    this.analyses = analyses;
    this.identity = identity;
    this.token = token.getBytes(StandardCharsets.UTF_8);
  }

  @PostMapping("/api/artifacts/{id}/analysis")
  Object analyze(@PathVariable UUID id, @RequestBody Analyze input) {
    return analyses.analyze(owner(), id, input.mode());
  }

  @GetMapping("/api/artifacts/{id}/analysis")
  Object latest(@PathVariable UUID id) {
    return analyses.latest(owner(), id);
  }

  @GetMapping("/api/audio/analyses/{id}")
  Object read(
      @PathVariable UUID id,
      @RequestParam(defaultValue = "transcript") String section,
      @RequestParam(defaultValue = "0") long cursor,
      @RequestParam(defaultValue = "100") int limit,
      @RequestParam(required = false) Double from,
      @RequestParam(required = false) Double to) {
    return analyses.page(owner(), id, section, cursor, limit, from, to);
  }

  @GetMapping("/internal/audio/{id}/intervals")
  Object intervals(
      @PathVariable UUID id,
      @RequestParam UUID attempt,
      @RequestParam double from,
      @RequestParam double to,
      @RequestParam(defaultValue = "0") long cursor,
      @RequestHeader(value = "X-Audio-Token", required = false) String supplied) {
    if (supplied == null
        || !MessageDigest.isEqual(token, supplied.getBytes(StandardCharsets.UTF_8))) {
      throw Identity.denied("Недопустимое внутреннее подключение.");
    }
    return analyses.intervals(id, attempt, from, to, cursor);
  }

  private UUID owner() {
    var actor = identity.current();
    if (!"WEB".equals(actor.channel())) {
      throw Identity.denied("Используйте канал MCP.");
    }
    return actor.id();
  }

  public record Analyze(String mode) {}
}
