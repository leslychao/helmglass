package ru.helmglass.api.connections;

import com.google.common.net.InternetDomainName;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/** The site boundary used to choose an account, independently of browser storage origins. */
@Service
public final class ConnectionSite {
  private static final int CHOICE_LIMIT = 50;
  private static final String CANDIDATE =
      "(rtrim(lower(site),'.') IN (:connectionSite,:connectionAlternateSite)"
          + " OR (:connectionSubdomains"
          + " AND (right(rtrim(lower(site),'.'),length(:connectionSuffix))=:connectionSuffix"
          + " OR right(rtrim(lower(site),'.'),length(:connectionAlternateSuffix))"
          + "=:connectionAlternateSuffix)))";
  private final JdbcClient jdbc;

  public ConnectionSite(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  private static Map<String, Object> parameters(Scope scope) {
    return Map.of(
        "connectionSite", scope.domain(),
        "connectionAlternateSite", scope.alternateDomain(),
        "connectionSubdomains", scope.subdomains(),
        "connectionSuffix", "." + scope.domain(),
        "connectionAlternateSuffix", "." + scope.alternateDomain());
  }

  private record Candidate(UUID id, String name, String site) {}

  public List<Map<String, String>> choices(UUID owner, String host, List<UUID> preferred) {
    Scope target = scope(host);
    Map<String, Object> parameters = new HashMap<>(parameters(target));
    parameters.put("owner", owner);
    String filter = "owner_id=:owner AND deleted_at IS NULL AND " + CANDIDATE;
    if (!preferred.isEmpty()) {
      parameters.put("ids", preferred);
      return candidates(filter + " AND id IN (:ids)",
          "last_used_at DESC NULLS LAST,id", parameters).stream()
          .filter(candidate -> matches(candidate.site(), target))
          .map(ConnectionSite::choice)
          .toList();
    }

    List<Map<String, String>> choices = new ArrayList<>();
    String cursor = "";
    while (true) {
      List<Candidate> batch = candidates(filter + " AND status='READY'" + cursor,
          "name,id LIMIT " + CHOICE_LIMIT, parameters);
      for (Candidate candidate : batch) {
        // A suffix is only a query prefilter: nested private suffixes can have other owners.
        if (matches(candidate.site(), target)) {
          choices.add(choice(candidate));
          if (choices.size() == CHOICE_LIMIT) {
            return choices;
          }
        }
      }
      if (batch.size() < CHOICE_LIMIT) {
        return choices;
      }
      Candidate last = batch.getLast();
      parameters.put("afterName", last.name());
      parameters.put("afterId", last.id());
      cursor = " AND (name,id)>(:afterName,:afterId)";
    }
  }

  public boolean hasPreferred(UUID owner, String host, List<UUID> preferred) {
    Scope target = scope(host);
    return jdbc.sql("SELECT site FROM connections WHERE owner_id=:owner AND id IN (:ids)")
        .param("owner", owner)
        .param("ids", preferred)
        .query(String.class)
        .list().stream()
        .anyMatch(site -> matches(site, target));
  }

  private List<Candidate> candidates(
      String filter, String order, Map<String, Object> parameters) {
    return jdbc.sql("SELECT id,name,site FROM connections WHERE " + filter + " ORDER BY " + order)
        .params(parameters)
        .query((row, index) -> new Candidate(
            row.getObject("id", UUID.class), row.getString("name"), row.getString("site")))
        .list();
  }

  private static Map<String, String> choice(Candidate candidate) {
    return Map.of("id", candidate.id().toString(), "label", candidate.name());
  }

  public static boolean matches(String connectionHost, String targetHost) {
    return matches(connectionHost, scope(targetHost));
  }

  private static boolean matches(String connectionHost, Scope target) {
    Scope connection = scope(connectionHost);
    boolean sameDomain = connection.domain().equals(target.domain());
    boolean alternateDomain = !connection.domain().equals(connection.alternateDomain())
        && !target.domain().equals(target.alternateDomain())
        && connection.alternateDomain().equals(target.domain());
    return !connection.domain().isEmpty() && (sameDomain || alternateDomain);
  }

  private record Scope(String domain, String alternateDomain, boolean subdomains) {}

  private static Scope scope(String host) {
    String normalized = host == null ? "" : host.toLowerCase(Locale.ROOT);
    if (normalized.endsWith(".")) {
      normalized = normalized.substring(0, normalized.length() - 1);
    }
    try {
      InternetDomainName domain = InternetDomainName.from(normalized);
      if (!domain.isUnderPublicSuffix()) {
        return new Scope(normalized, normalized, false);
      }
      InternetDomainName site = domain.topPrivateDomain();
      String boundary = site.toString();
      List<String> labels = site.parts();
      String suffix = labels.getLast();
      if (labels.size() == 2 && (suffix.equals("com") || suffix.equals("ru"))) {
        // Only the agreed .com/.ru pair shares an account-selection boundary.
        // Private suffixes retain their independent tenant boundaries.
        String name = labels.getFirst();
        String alternate = name + (suffix.equals("com") ? ".ru" : ".com");
        return new Scope(boundary, alternate, true);
      }
      return new Scope(boundary, boundary, true);
    } catch (IllegalArgumentException exception) {
      // IP addresses and non-DNS hosts keep their exact-host boundary.
      return new Scope(normalized, normalized, false);
    }
  }
}
