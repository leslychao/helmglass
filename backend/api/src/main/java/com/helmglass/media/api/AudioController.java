package com.helmglass.media.api;

import com.helmglass.identity.api.Actors;
import com.helmglass.media.application.MediaAnalysisService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AudioController {
  private final MediaAnalysisService media;

  public AudioController(MediaAnalysisService media) {
    this.media = media;
  }

  @GetMapping("/api/v1/audio/{id}")
  public Map<String, Object> get(@PathVariable UUID id, HttpServletRequest request) {
    return media.get(Actors.current(request), id, null);
  }

  @GetMapping("/api/v1/audio/{id}/segments")
  public Map<String, Object> segments(@PathVariable UUID id, @RequestParam String component,
      @RequestParam(required = false) String cursor, @RequestParam(defaultValue = "100") int limit,
      HttpServletRequest request) {
    return media.segments(Actors.current(request), id, null, component, cursor, limit);
  }
}
