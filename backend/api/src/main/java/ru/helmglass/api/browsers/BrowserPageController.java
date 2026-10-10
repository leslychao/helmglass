package ru.helmglass.api.browsers;

import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import ru.helmglass.api.auth.Identity;

@RestController
@RequestMapping("/api/browser-sessions/{session}/pages/{visit}")
public class BrowserPageController {
  private final Identity identity;
  private final BrowserPages pages;

  public BrowserPageController(Identity identity, BrowserPages pages) {
    this.identity = identity;
    this.pages = pages;
  }

  @PutMapping
  Map<String, Boolean> open(
      @PathVariable UUID session, @PathVariable UUID visit, @RequestBody PageInput input) {
    if (input.viewerId() == null) {
      throw new IllegalArgumentException("viewerId is required");
    }
    pages.open(owner(), session, visit, input.viewerId());
    return Map.of("active", true);
  }

  @DeleteMapping
  Map<String, Boolean> leave(@PathVariable UUID session, @PathVariable UUID visit) {
    pages.leave(owner(), session, visit);
    return Map.of("active", false);
  }

  @PostMapping("/activity")
  Map<String, Boolean> activity(
      @PathVariable UUID session, @PathVariable UUID visit, @RequestBody ActivityInput input) {
    pages.activity(owner(), session, visit, input.controlEpoch(), input.sequence());
    return Map.of("active", true);
  }

  private UUID owner() {
    var actor = identity.current();
    if (!"WEB".equals(actor.channel())) {
      throw Identity.denied("Используйте кабинет.");
    }
    return actor.id();
  }

  public record PageInput(UUID viewerId) {}

  public record ActivityInput(long controlEpoch, long sequence) {}
}
