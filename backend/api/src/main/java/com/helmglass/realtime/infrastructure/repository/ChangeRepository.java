package com.helmglass.realtime.infrastructure.repository;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.PageQuery;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class ChangeRepository {
  private static final UUID ADMIN_SCOPE = UUID.fromString("00000000-0000-0000-0000-000000000001");
  private static final Set<String> ADMIN_LIST_RESOURCES = Set.of("users", "audit");
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public ChangeRepository(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  public void changed(UUID userId, String resource, UUID aggregateId, long version) {
    List<String> resources =
        resource.equals("tasks") ? List.of("tasks", "usage") : List.of(resource);
    for (String changedResource : resources) {
      advance(userId, changedResource);
    }
    jdbc.sql(
            """
            INSERT INTO transactional_outbox(id,user_id,aggregate_id,aggregate_version,
              event_type,payload)
            VALUES(:id,:user,:aggregate,:version,:resource,CAST(:payload AS jsonb))
            ON CONFLICT(aggregate_id,aggregate_version,event_type,ordinal) DO NOTHING
            """)
        .param("id", UUID.randomUUID())
        .param("user", userId)
        .param("aggregate", aggregateId)
        .param("version", version)
        .param("resource", resource)
        .param("payload", json.write(Map.of("resources", resources, "resourceId", aggregateId)))
        .update();
  }

  private void advance(UUID userId, String resource) {
    jdbc.sql(
            """
            INSERT INTO list_revisions(scope_id,resource,revision) VALUES(:user,:resource,1)
            ON CONFLICT(scope_id,resource) DO UPDATE SET revision=list_revisions.revision+1
            """)
        .param("user", scope(userId, resource))
        .param("resource", resource)
        .update();
  }

  public String snapshot(UUID userId, String resource, PageQuery query) {
    long revision =
        jdbc.sql(
                """
                SELECT revision FROM list_revisions WHERE scope_id=:user AND resource=:resource
                """)
            .param("user", scope(userId, resource))
            .param("resource", resource)
            .query(Long.class)
            .optional()
            .orElse(0L);
    Map<String, List<String>> parameters = new TreeMap<>(query.filters());
    parameters.remove("snapshot");
    parameters.remove("page");
    String fingerprint =
        json.digest(Map.of("user", userId, "resource", resource, "parameters", parameters));
    if (query.snapshot() != null) {
      try {
        String[] parts =
            new String(Base64.getUrlDecoder().decode(query.snapshot()), StandardCharsets.UTF_8)
                .split(":", -1);
        if (parts.length != 3
            || Long.parseLong(parts[0]) != revision
            || !parts[1].equals(fingerprint)
            || Instant.now().getEpochSecond() > Long.parseLong(parts[2])) {
          throw DomainException.conflict("LIST_SNAPSHOT_EXPIRED", "Refresh the current list");
        }
        return query.snapshot();
      } catch (IllegalArgumentException error) {
        throw DomainException.conflict("LIST_SNAPSHOT_EXPIRED", "Refresh the current list");
      }
    }
    String value =
        revision + ":" + fingerprint + ":" + Instant.now().plusSeconds(300).getEpochSecond();
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static UUID scope(UUID userId, String resource) {
    return ADMIN_LIST_RESOURCES.contains(resource) ? ADMIN_SCOPE : userId;
  }
}
