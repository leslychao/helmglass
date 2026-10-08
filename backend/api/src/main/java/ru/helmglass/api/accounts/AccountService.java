package ru.helmglass.api.accounts;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Database;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.artifacts.ArtifactService;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.browsers.WorkerClient;
import ru.helmglass.api.events.EventService;
import ru.helmglass.api.tasks.TaskService;
import ru.helmglass.api.usage.UsageService;

@Service
public class AccountService {
  private static final Logger log = LoggerFactory.getLogger(AccountService.class);
  private static final String USER_SELECT =
      """
SELECT a.*,
  (SELECT count(*) FROM browser_sessions b WHERE b.owner_id=a.id AND b.status NOT IN ('CLOSED','QUEUED')) browser_count,
  (SELECT count(*) FROM tasks t WHERE t.owner_id=a.id AND t.status IN ('QUEUED','WAITING_CHATGPT','WAITING_USER')) waiting_count,
  (SELECT count(*) FROM administrative_jobs j WHERE j.owner_id=a.id AND j.status NOT IN ('SUCCEEDED','CANCELLED'))
    + (SELECT count(*) FROM administrative_audit d WHERE d.owner_id=a.id AND d.action='STOP_TASK' AND d.status='PENDING') pending_operations
FROM accounts a
""";
  private final JdbcClient jdbc;
  private final JsonSupport json;
  private final TaskService tasks;
  private final EventService events;
  private final UsageService usage;
  private final ArtifactService artifacts;
  private final WorkerClient worker;
  private final ru.helmglass.api.browsers.ViewerAccess viewers;
  private final ru.helmglass.api.auth.IdentityLifecycle identityLifecycle;
  private final ru.helmglass.api.browsers.BrowserService browserService;
  private final TransactionTemplate transactions;
  private final ProfileImage profileImages;
  private final Identity identity;
  private UUID profileCleanupCursor = new UUID(0, 0);

  public AccountService(
      JdbcClient jdbc,
      JsonSupport json,
      TaskService tasks,
      EventService events,
      UsageService usage,
      ArtifactService artifacts,
      WorkerClient worker,
      ru.helmglass.api.browsers.ViewerAccess viewers,
      ru.helmglass.api.browsers.BrowserService browserService,
      ru.helmglass.api.auth.IdentityLifecycle identityLifecycle,
      ProfileImage profileImages,
      Identity identity,
      org.springframework.transaction.PlatformTransactionManager manager) {
    this.jdbc = jdbc;
    this.json = json;
    this.tasks = tasks;
    this.events = events;
    this.usage = usage;
    this.artifacts = artifacts;
    this.worker = worker;
    this.viewers = viewers;
    this.browserService = browserService;
    this.identityLifecycle = identityLifecycle;
    this.profileImages = profileImages;
    this.identity = identity;
    transactions = new TransactionTemplate(manager);
  }

  @Transactional
  public Map<String, Object> stopTaskBrowser(Actor actor, UUID id) {
    var reference = browserService.reference(id);
    if (reference.taskId() == null) {
      throw ApiException.conflict(
          "NO_TASK", "У браузера нет задачи. Используйте остановку всей работы пользователя.");
    }
    tasks.lockOwner(reference.ownerId());
    String previous = tasks.get(reference.ownerId(), reference.taskId()).status();
    tasks.requestStop(reference.ownerId(), reference.taskId());
    String current = tasks.get(reference.ownerId(), reference.taskId()).status();
    writeAudit(
        actor.id(),
        reference.taskId(),
        reference.ownerId(),
        "STOP_TASK",
        null,
        Map.of("status", previous),
        Map.of("status", current),
        "STOPPING".equals(current) ? "PENDING" : "SUCCEEDED");
    return Map.of("status", current, "taskId", reference.taskId());
  }

  public Contracts.Me me(Actor actor) {
    return jdbc.sql(
            "SELECT a.id,a.version,a.name,a.email,a.status,p.id avatar_id FROM accounts a"
                + " LEFT JOIN account_avatars p ON p.owner_id=a.id WHERE a.id=:id")
        .param("id", actor.id())
        .query(
            (row, index) ->
                new Contracts.Me(
                    row.getObject("id", UUID.class),
                    row.getLong("version"),
                    row.getString("name"),
                    row.getString("email"),
                    row.getString("status"),
                    actor.roles(),
                    row.getObject("avatar_id") == null
                        ? null
                        : "/api/me/avatar?v=" + row.getObject("avatar_id", UUID.class)))
        .single();
  }

  @Transactional
  public Contracts.Me updateProfile(
      Actor actor, Contracts.ProfileInput input, ProfileImage.Upload image) {
    tasks.lockOwner(actor.id());
    identity.requireGrant(actor);
    Contracts.Me previous = me(actor);
    if (!"ACTIVE".equals(previous.status()) || !"WEB".equals(actor.channel())) {
      throw Identity.denied("Редактирование профиля недоступно.");
    }
    if (input.expectedVersion() == null || input.expectedVersion() != previous.version()) {
      throw ApiException.conflict(
          "STALE_VERSION", "Профиль изменился. Получите актуальные данные.");
    }
    String name = input.name() == null ? "" : input.name().strip();
    if (name.isEmpty()
        || name.length() > 300
        || name.codePoints().anyMatch(Character::isISOControl)) {
      throw ApiException.invalid(
          "name", "Введите имя от 1 до 300 символов без управляющих знаков.");
    }
    if (image != null) {
      TransactionSynchronizationManager.registerSynchronization(
          new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
              if (status != STATUS_COMMITTED) {
                try {
                  Files.deleteIfExists(image.destination());
                } catch (IOException exception) {
                  log.warn("Uncommitted profile image cleanup pending for {}", actor.id());
                }
              }
            }
          });
      try {
        image.install();
      } catch (IOException exception) {
        throw new ApiException(
            HttpStatus.SERVICE_UNAVAILABLE,
            "PROFILE_IMAGE_UNAVAILABLE",
            "Не удалось сохранить фотографию. Изменения не применены.");
      }
      jdbc.sql(
              """
              INSERT INTO account_avatars(owner_id,id,content_type,size_bytes,sha256)
              VALUES (:owner,:id,:type,:size,:sha) ON CONFLICT(owner_id) DO UPDATE
              SET id=EXCLUDED.id,content_type=EXCLUDED.content_type,
                size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256
              """)
          .param("owner", actor.id())
          .param("id", image.id())
          .param("type", image.contentType())
          .param("size", image.sizeBytes())
          .param("sha", image.sha256())
          .update();
    }
    long version =
        jdbc.sql(
                "UPDATE accounts SET name=:name,version=version+1 WHERE id=:owner RETURNING"
                    + " version")
            .param("name", name)
            .param("owner", actor.id())
            .query(Long.class)
            .single();
    events.emit(actor.id(), "account", actor.id(), version);
    events.emitAdministrators("admin-user", actor.id(), version);
    return me(actor);
  }

  public AvatarFile avatar(Actor actor, UUID expectedImage) {
    AvatarMetadata metadata =
        jdbc.sql("SELECT id,content_type,size_bytes FROM account_avatars WHERE owner_id=:owner")
            .param("owner", actor.id())
            .query(
                (row, index) ->
                    new AvatarMetadata(
                        row.getObject("id", UUID.class),
                        row.getString("content_type"),
                        row.getInt("size_bytes")))
            .optional()
            .orElseThrow(ApiException::notFound);
    if (expectedImage != null && !expectedImage.equals(metadata.id())) {
      throw ApiException.notFound();
    }
    var path = profileImages.path(actor.id(), metadata.id());
    try {
      if (Files.size(path) != metadata.sizeBytes()) {
        throw new IOException("Profile image is incomplete");
      }
      return new AvatarFile(
          metadata.contentType(), metadata.sizeBytes(), Files.newInputStream(path));
    } catch (IOException exception) {
      throw new ApiException(
          HttpStatus.CONFLICT, "PROFILE_IMAGE_UNAVAILABLE", "Фотография временно недоступна.");
    }
  }

  public record AvatarFile(String contentType, int sizeBytes, InputStream content) {}

  private record AvatarMetadata(UUID id, String contentType, int sizeBytes) {}

  public Object integration(UUID owner, String publicUrl) {
    boolean connected =
        jdbc.sql(
                "SELECT mcp_connected_at IS NOT NULL AND (mcp_revoked_at IS NULL OR"
                    + " mcp_connected_at>mcp_revoked_at) FROM accounts WHERE id=:owner")
            .param("owner", owner)
            .query(Boolean.class)
            .single();
    Map<String, Object> result = new java.util.LinkedHashMap<>(viewers.status(owner, "MCP"));
    result.putAll(
        Map.of(
            "connected",
            connected,
            "endpoint",
            publicUrl + "/mcp",
            "accountUrl",
            publicUrl + "/auth/realms/helmglass/account/"));
    return result;
  }

  @Transactional
  public RevokeReceipt revokeMcp(UUID owner) {
    jdbc.sql("UPDATE accounts SET mcp_revoked_at=now(),version=version+1 WHERE id=:id")
        .param("id", owner)
        .update();
    jdbc.sql(
            "UPDATE operations SET status='CANCELLED',completed_at=now() WHERE owner_id=:owner AND"
                + " status IN ('ACCEPTED','AWAITING_CONFIRMATION')")
        .param("owner", owner)
        .update();
    events.emit(owner, "integration", owner, 0);
    var closure = viewers.revoke(owner, "MCP", null);
    return new RevokeReceipt(true, closure.status(), closure.message());
  }

  public Contracts.AdminUsersSummary usersSummary() {
    return jdbc.sql(
            """
            SELECT count(*) AS users,count(*) FILTER (WHERE status='BLOCKED') AS blocked,
              (SELECT count(*) FROM tasks t JOIN accounts owner ON owner.id=t.owner_id
                WHERE owner.status<>'DELETED'
                  AND t.status IN ('QUEUED','WAITING_CHATGPT','WAITING_USER')) AS waiting_tasks
            FROM accounts WHERE status<>'DELETED'
            """)
        .query(
            (row, index) ->
                new Contracts.AdminUsersSummary(
                    row.getLong("users"), row.getLong("blocked"), row.getLong("waiting_tasks")))
        .single();
  }

  public Contracts.Page<AdminUser> users(ListQuery query, List<String> flags) {
    List<String> clauses = new ArrayList<>(List.of("a.status<>'DELETED'"));
    Map<String, Object> parameters = new HashMap<>();
    if (query.search() != null && !query.search().isBlank()) {
      clauses.add("(a.name ILIKE :search OR a.email ILIKE :search OR a.id::text ILIKE :search)");
      parameters.put("search", "%" + query.search() + "%");
    }
    ListQuery.addList(clauses, parameters, "a.status", "status", query.status());
    if (flags.contains("waiting")) {
      clauses.add(
          "EXISTS(SELECT 1 FROM tasks t WHERE t.owner_id=a.id AND t.status IN"
              + " ('QUEUED','WAITING_USER','WAITING_CHATGPT'))");
    }
    if (flags.contains("pending")) {
      clauses.add(
          "(EXISTS(SELECT 1 FROM administrative_jobs j WHERE j.owner_id=a.id AND j.status IN"
              + " ('PENDING','RUNNING')) OR EXISTS(SELECT 1 FROM administrative_audit d WHERE"
              + " d.owner_id=a.id AND d.action='STOP_TASK' AND d.status='PENDING'))");
    }
    String where = String.join(" AND ", clauses);
    long total =
        jdbc.sql("SELECT count(*) FROM accounts a WHERE " + where)
            .params(parameters)
            .query(Long.class)
            .single();
    String order =
        switch (query.sort() == null ? "" : query.sort()) {
          case "name" -> "a.name";
          case "email" -> "a.email";
          case "status" -> "a.status";
          case "browserCount" -> "browser_count";
          case "waitingCount" -> "waiting_count";
          default -> "a.last_seen_at";
        };
    var items =
        jdbc.sql(
                USER_SELECT
                    + " WHERE "
                    + where
                    + " ORDER BY "
                    + order
                    + (query.ascending() ? " ASC" : " DESC")
                    + ",a.id LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(this::mapUser)
            .list();
    return new Contracts.Page<>(items, total, query.page(), query.pageSize());
  }

  public AdminUser user(UUID id) {
    return jdbc.sql(USER_SELECT + " WHERE a.id=:id")
        .param("id", id)
        .query(this::mapUser)
        .optional()
        .orElseThrow(ApiException::notFound);
  }

  public AdminDetail detail(
      UUID id, int taskPage, int auditPage, int taskPageSize, int auditPageSize, String timezone) {
    if (taskPage < 1
        || auditPage < 1
        || taskPage > 1000000
        || auditPage > 1000000
        || !Set.of(10, 20, 50).contains(taskPageSize)
        || !Set.of(10, 20, 50).contains(auditPageSize)) {
      throw ApiException.invalid("page", "Некорректная страница.");
    }
    AdminUser user = user(id);
    Instant end = Instant.now();
    java.time.ZoneId zone = UsageService.zone(timezone);
    Instant start = LocalDate.now(zone).minusDays(6).atStartOfDay(zone).toInstant();
    long taskCount =
        jdbc.sql("SELECT least(count(*),50) FROM tasks WHERE owner_id=:id")
            .param("id", id)
            .query(Long.class)
            .single();
    var recentTasks =
        jdbc.sql(
                "SELECT id,status,browser_session_id,wait_reason,created_at FROM tasks WHERE"
                    + " owner_id=:id ORDER BY created_at DESC,id LIMIT :limit OFFSET :offset")
            .param("id", id)
            .param(
                "limit",
                Math.max(0, Math.min(taskPageSize, 50L - (long) (taskPage - 1) * taskPageSize)))
            .param("offset", (long) (taskPage - 1) * taskPageSize)
            .query(
                (row, index) ->
                    new AdminTask(
                        row.getObject("id", UUID.class),
                        row.getString("status"),
                        row.getObject("browser_session_id", UUID.class),
                        row.getString("wait_reason"),
                        Database.instant(row, "created_at")))
            .list();
    var jobs =
        jdbc.sql(
                "SELECT id,type,status FROM (SELECT id,type,status,created_at FROM"
                    + " administrative_jobs WHERE owner_id=:id AND status NOT IN"
                    + " ('SUCCEEDED','CANCELLED') UNION ALL SELECT id,action AS"
                    + " type,status,created_at FROM administrative_audit WHERE owner_id=:id AND"
                    + " action='STOP_TASK' AND status='PENDING') pending ORDER BY created_at,id"
                    + " LIMIT 50")
            .param("id", id)
            .query(
                (row, index) ->
                    new AdminOperation(
                        row.getObject("id", UUID.class),
                        row.getString("status"),
                        row.getString("type")))
            .list();
    return new AdminDetail(
        user,
        usage.administration(id, start, end),
        new Contracts.Page<>(recentTasks, taskCount, taskPage, taskPageSize),
        jobs,
        audit(
            id,
            new ListQuery(
                null,
                List.of(),
                List.of(),
                List.of(),
                null,
                null,
                null,
                false,
                auditPage,
                auditPageSize)));
  }

  @Transactional
  public AdminUser command(Actor actor, UUID target, Contracts.AdminCommand input) {
    if (!actor.administrator()) {
      throw Identity.denied("Нет административных прав.");
    }
    tasks.lockOwner(target);
    AdminUser previous = user(target);
    String type = TaskService.required(input.type(), "type", 50);
    String reason =
        "STOP_ALL".equals(type) ? null : TaskService.required(input.reason(), "reason", 1000);
    if (actor.id().equals(target) && Set.of("BLOCK", "REQUEST_DELETION").contains(type)) {
      throw ApiException.conflict(
          "SELF_ADMINISTRATION", "Нельзя заблокировать или удалить собственный аккаунт.");
    }
    if (!"STOP_ALL".equals(type)
        && (input.expectedVersion() == null || input.expectedVersion() != previous.version())) {
      throw ApiException.conflict(
          "STALE_VERSION", "Аккаунт изменился. Проверьте актуальные данные.");
    }
    switch (type) {
      case "LIMITS" -> {
        if (!Set.of("PLATFORM", "CUSTOM", "UNLIMITED")
                .contains(input.browserLimitMode() == null ? "" : input.browserLimitMode())
            || "CUSTOM".equals(input.browserLimitMode())
                && (input.browserLimit() == null || input.browserLimit() < 1)
            || input.waitingLimit() != null && input.waitingLimit() < 0) {
          throw ApiException.invalid("limits", "Недопустимое значение лимита.");
        }
        jdbc.sql(
                "UPDATE accounts SET"
                    + " browser_limit_mode=:mode,browser_limit=:limit,waiting_limit=:waiting,version=version+1"
                    + " WHERE id=:id")
            .param("mode", input.browserLimitMode())
            .param("limit", "CUSTOM".equals(input.browserLimitMode()) ? input.browserLimit() : null)
            .param("waiting", input.waitingLimit())
            .param("id", target)
            .update();
      }
      case "BLOCK" -> {
        requireState(previous, "ACTIVE");
        revokeAccess(target, "BLOCKED");
        stopAll(target, type);
      }
      case "UNBLOCK" -> {
        requireState(previous, "BLOCKED");
        jdbc.sql(
                "UPDATE accounts SET"
                    + " status='ACTIVE',access_after=date_trunc('second',now())+interval '1"
                    + " second',access_epoch=access_epoch+1,version=version+1 WHERE id=:id")
            .param("id", target)
            .update();
      }
      case "REQUEST_DELETION" -> {
        if (!Set.of("ACTIVE", "BLOCKED").contains(previous.status())) {
          throw ApiException.conflict("ACCOUNT_STATE", "Удаление уже запрошено.");
        }
        jdbc.sql(
                "UPDATE accounts SET previous_status=status,deletion_due_at=now()+interval '168"
                    + " hours' WHERE id=:id")
            .param("id", target)
            .update();
        revokeAccess(target, "DELETION_PENDING");
        stopAll(target, type);
      }
      case "CANCEL_DELETION" -> {
        int changed =
            jdbc.sql(
                    "UPDATE accounts SET"
                        + " status=previous_status,previous_status=NULL,deletion_due_at=NULL,access_after=date_trunc('second',now())+interval"
                        + " '1 second',version=version+1 WHERE id=:id AND status='DELETION_PENDING'"
                        + " AND deletion_due_at>now()")
                .param("id", target)
                .update();
        if (changed == 0) {
          throw ApiException.conflict(
              "DELETION_EXPIRED", "Срок отмены удаления истёк или удаления нет.");
        }
      }
      case "STOP_ALL" -> stopAll(target, type);
      default -> throw ApiException.invalid("type", "Неизвестное административное действие.");
    }
    AdminUser current = user(target);
    writeAudit(
        actor.id(),
        target,
        target,
        type,
        reason,
        previous,
        current,
        Set.of("BLOCK", "REQUEST_DELETION", "STOP_ALL").contains(type) ? "PENDING" : "SUCCEEDED");
    events.emit(target, "account", target, current.version());
    events.emitAdministrators("admin-user", target, current.version());
    return current;
  }

  private void revokeAccess(UUID target, String status) {
    jdbc.sql(
            "UPDATE accounts SET status=:status,access_after=date_trunc('second',now())+interval '1"
                + " second',access_epoch=access_epoch+1,version=version+1 WHERE id=:id")
        .param("status", status)
        .param("id", target)
        .update();
    var sessions =
        jdbc.sql(
                "UPDATE browser_sessions SET"
                    + " control_epoch=control_epoch+1,control_owner='NONE',controller_id=NULL,private_mode=true,pending_control=NULL,close_requested=true"
                    + " WHERE owner_id=:owner AND status NOT IN ('CLOSED','LOST') RETURNING"
                    + " id,control_epoch")
            .param("owner", target)
            .query(
                (row, index) ->
                    new Revocation(row.getObject("id", UUID.class), row.getLong("control_epoch")))
            .list();
    for (Revocation session : sessions) {
      try {
        worker.call(
            "POST",
            "/sessions/" + session.id() + "/control",
            Map.of("controlEpoch", session.epoch(), "owner", "NONE", "privateMode", true));
      } catch (WorkerClient.WorkerException exception) {
        jdbc.sql(
                "UPDATE browser_sessions SET status='UNREACHABLE' WHERE id=:id AND status NOT IN"
                    + " ('CLOSED','LOST','QUEUED')")
            .param("id", session.id())
            .update();
      }
    }
  }

  private void stopAll(UUID target, String type) {
    long cutoff =
        jdbc.sql("SELECT event_sequence FROM accounts WHERE id=:id")
            .param("id", target)
            .query(Long.class)
            .single();
    jdbc.sql(
            "INSERT INTO administrative_jobs(id,owner_id,type,cutoff_sequence) VALUES"
                + " (:id,:owner,:type,:cutoff)")
        .param("id", UUID.randomUUID())
        .param("owner", target)
        .param("type", type)
        .param("cutoff", cutoff)
        .update();
  }

  public Contracts.Page<Audit> audit(UUID user, ListQuery query) {
    return audit(user, query, List.of());
  }

  public Contracts.Page<Audit> audit(UUID user, ListQuery query, List<String> actions) {
    List<String> clauses = new ArrayList<>(List.of("created_at>=now()-interval '365 days'"));
    Map<String, Object> parameters = new HashMap<>();
    if (user != null) {
      clauses.add("owner_id=:user");
      parameters.put("user", user);
    }
    if (query.search() != null && !query.search().isBlank()) {
      clauses.add(
          "(action ILIKE :search OR reason ILIKE :search OR actor_id::text ILIKE :search OR"
              + " target_id::text ILIKE :search)");
      parameters.put("search", "%" + query.search() + "%");
    }
    ListQuery.addList(clauses, parameters, "status", "status", query.status());
    ListQuery.addList(clauses, parameters, "action", "action", actions);
    if (query.from() != null) {
      clauses.add("created_at>=:from");
      parameters.put("from", java.sql.Timestamp.from(query.from()));
    }
    if (query.to() != null) {
      clauses.add("created_at<:to");
      parameters.put("to", java.sql.Timestamp.from(query.to()));
    }
    String where = String.join(" AND ", clauses);
    long total =
        jdbc.sql("SELECT count(*) FROM administrative_audit WHERE " + where)
            .params(parameters)
            .query(Long.class)
            .single();
    var rows =
        jdbc.sql(
                "SELECT * FROM administrative_audit WHERE "
                    + where
                    + " ORDER BY created_at DESC,id LIMIT :limit OFFSET :offset")
            .params(parameters)
            .param("limit", query.pageSize())
            .param("offset", query.offset())
            .query(
                (row, index) ->
                    new Audit(
                        row.getObject("id", UUID.class),
                        Database.instant(row, "created_at"),
                        row.getString("actor_id"),
                        row.getString("target_id"),
                        row.getString("action"),
                        row.getString("reason"),
                        row.getString("before_value"),
                        row.getString("after_value"),
                        row.getString("status")))
            .list();
    return new Contracts.Page<>(rows, total, query.page(), query.pageSize());
  }

  public void writeAudit(
      UUID actor,
      UUID target,
      UUID owner,
      String action,
      String reason,
      Object before,
      Object after,
      String status) {
    jdbc.sql(
            "INSERT INTO"
                + " administrative_audit(id,actor_id,target_id,owner_id,action,reason,before_value,after_value,status)"
                + " VALUES (:id,:actor,:target,:owner,:action,:reason,CAST(:before AS"
                + " jsonb),CAST(:after AS jsonb),:status)")
        .param("id", UUID.randomUUID())
        .param("actor", actor)
        .param("target", target)
        .param("owner", owner)
        .param("action", action)
        .param("reason", reason)
        .param("before", json.write(before))
        .param("after", json.write(after))
        .param("status", status)
        .update();
    events.emitAdministrators("admin-audit", target, 0);
  }

  @Scheduled(fixedDelay = 2000)
  public void applyAdministrativeJobs() {
    transactions.executeWithoutResult(transaction -> completeTaskStops(null));
    var jobs =
        jdbc.sql(
                "SELECT id,owner_id,cutoff_sequence FROM administrative_jobs WHERE status IN"
                    + " ('PENDING','RUNNING') ORDER BY created_at LIMIT 20")
            .query(
                (row, index) ->
                    new Job(
                        row.getObject("id", UUID.class),
                        row.getObject("owner_id", UUID.class),
                        row.getLong("cutoff_sequence")))
            .list();
    for (Job job : jobs) {
      transactions.executeWithoutResult(
          transaction -> {
            tasks.lockOwner(job.owner());
            jdbc.sql(
                    "UPDATE administrative_jobs SET status='RUNNING',updated_at=now() WHERE id=:id")
                .param("id", job.id())
                .update();
            var accepted =
                jdbc.sql(
                        "SELECT id FROM tasks WHERE owner_id=:owner AND accepted_sequence<=:cutoff"
                            + " AND status NOT IN"
                            + " ('DRAFT','STOPPING','STOPPED','FAILED','SUCCEEDED','PARTIAL','NOT_ACHIEVED')"
                            + " ORDER BY accepted_sequence LIMIT 100")
                    .param("owner", job.owner())
                    .param("cutoff", job.cutoff())
                    .query(UUID.class)
                    .list();
            for (UUID task : accepted) {
              tasks.requestStop(job.owner(), task);
            }
            jdbc.sql(
                    "UPDATE browser_sessions SET close_requested=true WHERE owner_id=:owner AND"
                        + " allocation_sequence<=:cutoff AND status<>'CLOSED'")
                .param("owner", job.owner())
                .param("cutoff", job.cutoff())
                .update();
            jdbc.sql(
                    "UPDATE browser_sessions SET status='CLOSED',closed_at=now() WHERE"
                        + " owner_id=:owner AND close_requested AND status='QUEUED'")
                .param("owner", job.owner())
                .update();
            boolean remaining =
                jdbc.sql(
                        "SELECT EXISTS(SELECT 1 FROM browser_sessions WHERE owner_id=:owner AND"
                            + " allocation_sequence<=:cutoff AND status<>'CLOSED') OR EXISTS(SELECT"
                            + " 1 FROM tasks WHERE owner_id=:owner AND accepted_sequence<=:cutoff"
                            + " AND status IN"
                            + " ('STOPPING','RUNNING','QUEUED','STARTING','WAITING_USER','WAITING_CHATGPT','PAUSED','PAUSING'))")
                    .param("owner", job.owner())
                    .param("cutoff", job.cutoff())
                    .query(Boolean.class)
                    .single();
            if (!remaining) {
              jdbc.sql(
                      "UPDATE administrative_jobs SET status='SUCCEEDED',updated_at=now() WHERE"
                          + " id=:id")
                  .param("id", job.id())
                  .update();
              jdbc.sql(
                      "UPDATE administrative_audit SET status='SUCCEEDED' WHERE target_id=:owner"
                          + " AND status='PENDING' AND action IN"
                          + " ('STOP_ALL','BLOCK','REQUEST_DELETION')")
                  .param("owner", job.owner())
                  .update();
              events.emit(job.owner(), "account", job.owner(), 0);
              events.emitAdministrators("admin-operation", job.owner(), 0);
            }
          });
    }
  }

  private void completeTaskStops(UUID owner) {
    var completed =
        jdbc.sql(
                """
                WITH ready AS (
                  SELECT a.id FROM administrative_audit a
                  WHERE a.action='STOP_TASK' AND a.status='PENDING'
                    AND (CAST(:owner AS uuid) IS NULL OR a.owner_id=CAST(:owner AS uuid))
                    AND EXISTS(SELECT 1 FROM task_history h WHERE h.task_id=a.target_id
                      AND h.type='STOPPED' AND h.created_at>=a.created_at)
                  ORDER BY a.created_at LIMIT 100 FOR UPDATE SKIP LOCKED
                )
                UPDATE administrative_audit a SET status='SUCCEEDED',
                  after_value=jsonb_set(a.after_value,'{status}','"STOPPED"'::jsonb)
                FROM ready WHERE a.id=ready.id RETURNING a.target_id,a.owner_id
                """)
            .param("owner", owner == null ? null : owner.toString())
            .query(
                (row, index) ->
                    new CompletedTaskStop(
                        row.getObject("target_id", UUID.class),
                        row.getObject("owner_id", UUID.class)))
            .list();
    for (CompletedTaskStop stop : completed) {
      events.emitAdministrators("admin-audit", stop.task(), 0);
      if (stop.owner() != null) {
        events.emitAdministrators("admin-operation", stop.owner(), 0);
        events.emitAdministrators("admin-user", stop.owner(), 0);
      }
    }
  }

  @Scheduled(fixedDelay = 30000)
  public void purgeDueAccounts() {
    cleanupProfileImages();
    var owners =
        jdbc.sql(
                "SELECT id FROM accounts WHERE (status='DELETION_PENDING' AND"
                    + " deletion_due_at<=now()) OR status='PURGING' ORDER BY deletion_due_at LIMIT"
                    + " 10")
            .query(UUID.class)
            .list();
    for (UUID owner : owners) {
      boolean ready =
          Boolean.TRUE.equals(
              transactions.execute(
                  status -> {
                    tasks.lockOwner(owner);
                    boolean stopped =
                        jdbc.sql(
                                "SELECT NOT EXISTS(SELECT 1 FROM browser_sessions WHERE"
                                    + " owner_id=:owner AND status<>'CLOSED')")
                            .param("owner", owner)
                            .query(Boolean.class)
                            .single();
                    if (stopped) {
                      var changed =
                          jdbc.sql(
                                  "UPDATE accounts SET status='PURGING',version=version+1 WHERE"
                                      + " id=:id AND status='DELETION_PENDING' AND"
                                      + " deletion_due_at<=now() RETURNING version")
                              .param("id", owner)
                              .query(Long.class)
                              .optional();
                      if (changed.isPresent()) {
                        events.emit(owner, "account", owner, changed.get());
                        events.emitAdministrators("admin-user", owner, changed.get());
                      }
                    }
                    return stopped;
                  }));
      if (!ready || !artifacts.purgeBatch(owner) || !purgeProfileImage(owner)) {
        continue;
      }
      boolean profilesRemoved = true;
      var profiles =
          jdbc.sql(
                  "SELECT id FROM connections WHERE owner_id=:owner AND status<>'DELETED' LIMIT"
                      + " 100")
              .param("owner", owner)
              .query(UUID.class)
              .list();
      for (UUID connection : profiles) {
        try {
          worker.call("DELETE", "/profiles/" + connection, null);
          jdbc.sql("UPDATE connections SET status='DELETED' WHERE id=:id")
              .param("id", connection)
              .update();
        } catch (WorkerClient.WorkerException exception) {
          if (exception.status() == 404) {
            jdbc.sql("UPDATE connections SET status='DELETED' WHERE id=:id")
                .param("id", connection)
                .update();
          } else {
            profilesRemoved = false;
          }
        }
      }
      if (profilesRemoved && profiles.size() < 100 && identityLifecycle.delete(owner)) {
        purgeRecords(owner);
      }
    }
    jdbc.sql("DELETE FROM administrative_audit WHERE created_at<now()-interval '365 days'")
        .update();
  }

  private boolean purgeProfileImage(UUID owner) {
    return Boolean.TRUE.equals(
        transactions.execute(
            transaction -> {
              tasks.lockOwner(owner);
              try {
                if (!profileImages.cleanup(owner, null, true)) {
                  return false;
                }
                jdbc.sql("DELETE FROM account_avatars WHERE owner_id=:owner")
                    .param("owner", owner)
                    .update();
                return true;
              } catch (IOException exception) {
                log.warn("Profile image purge pending for {}", owner);
                return false;
              }
            }));
  }

  private void cleanupProfileImages() {
    var owners =
        jdbc.sql("SELECT id FROM accounts WHERE id>:cursor ORDER BY id LIMIT 100")
            .param("cursor", profileCleanupCursor)
            .query(UUID.class)
            .list();
    for (UUID owner : owners) {
      transactions.executeWithoutResult(
          transaction -> {
            tasks.lockOwner(owner);
            UUID current =
                jdbc.sql("SELECT id FROM account_avatars WHERE owner_id=:owner")
                    .param("owner", owner)
                    .query(UUID.class)
                    .optional()
                    .orElse(null);
            try {
              profileImages.cleanup(owner, current, false);
            } catch (IOException exception) {
              log.warn("Old profile image cleanup pending for {}", owner);
            }
          });
    }
    profileCleanupCursor = owners.size() < 100 ? new UUID(0, 0) : owners.getLast();
  }

  private void purgeRecords(UUID owner) {
    transactions.executeWithoutResult(
        transaction -> {
          tasks.lockOwner(owner);
          completeTaskStops(owner);
          if (jdbc.sql(
                  "SELECT EXISTS(SELECT 1 FROM administrative_audit WHERE owner_id=:owner"
                      + " AND action='STOP_TASK' AND status='PENDING')")
              .param("owner", owner)
              .query(Boolean.class)
              .single()) {
            return;
          }
          for (String table :
              List.of(
                  "mcp_chats",
                  "mcp_task_chats",
                  "notifications",
                  "task_history",
                  "result_rows",
                  "task_requests",
                  "operations",
                  "usage_intervals")) {
            jdbc.sql("DELETE FROM " + table + " WHERE owner_id=:owner")
                .param("owner", owner)
                .update();
          }
          jdbc.sql("UPDATE tasks SET browser_session_id=NULL WHERE owner_id=:owner")
              .param("owner", owner)
              .update();
          for (String table :
              List.of(
                  "browser_sessions",
                  "tasks",
                  "connections",
                  "idempotency_records",
                  "user_events",
                  "revoked_sessions",
                  "viewer_revocations",
                  "administrative_jobs")) {
            jdbc.sql("DELETE FROM " + table + " WHERE owner_id=:owner")
                .param("owner", owner)
                .update();
          }
          var changed =
              jdbc.sql(
                      "UPDATE accounts SET name='Удалённый"
                          + " пользователь',email='',status='DELETED',previous_status=NULL,version=version+1"
                          + " WHERE id=:id AND status='PURGING' RETURNING version")
                  .param("id", owner)
                  .query(Long.class)
                  .optional();
          if (changed.isPresent()) {
            events.emitAdministrators("admin-user", owner, changed.get());
          }
        });
  }

  private static void requireState(AdminUser user, String state) {
    if (!state.equals(user.status())) {
      throw ApiException.conflict(
          "ACCOUNT_STATE", "Действие недоступно в текущем состоянии аккаунта.");
    }
  }

  private AdminUser mapUser(java.sql.ResultSet row, int index) throws java.sql.SQLException {
    return new AdminUser(
        row.getObject("id", UUID.class),
        row.getLong("version"),
        row.getString("name"),
        row.getString("email"),
        row.getString("status"),
        row.getString("browser_limit_mode"),
        row.getObject("browser_limit", Integer.class),
        row.getObject("waiting_limit", Integer.class),
        row.getLong("browser_count"),
        row.getLong("waiting_count"),
        Database.instant(row, "last_seen_at"),
        row.getLong("pending_operations"),
        Database.instant(row, "deletion_due_at"),
        row.getString("previous_status"));
  }

  public record RevokeReceipt(boolean revoked, String status, String message) {}

  public record AdminUser(
      UUID id,
      long version,
      String name,
      String email,
      String status,
      String browserLimitMode,
      Integer browserLimit,
      Integer waitingLimit,
      Long browserCount,
      long waitingCount,
      Instant lastAccessAt,
      long pendingOperations,
      Instant deleteUntil,
      String previousStatus) {}

  public record AdminTask(
      UUID id, String status, UUID browserId, String reason, Instant createdAt) {}

  public record Audit(
      UUID id,
      Instant createdAt,
      String actor,
      String target,
      String action,
      String reason,
      String before,
      String after,
      String status) {}

  public record AdminOperation(UUID id, String status, String description) {}

  public record AdminDetail(
      AdminUser user,
      UsageService.AdminUsage usage,
      Contracts.Page<AdminTask> tasks,
      List<AdminOperation> operations,
      Contracts.Page<Audit> audit) {}

  private record CompletedTaskStop(UUID task, UUID owner) {}

  private record Job(UUID id, UUID owner, long cutoff) {}

  private record Revocation(UUID id, long epoch) {}
}
