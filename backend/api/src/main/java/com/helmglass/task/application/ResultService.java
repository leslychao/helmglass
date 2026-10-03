package com.helmglass.task.application;

import com.helmglass.api.DomainException;
import com.helmglass.api.JsonSupport;
import com.helmglass.api.MutationContext;
import com.helmglass.api.PageQuery;
import com.helmglass.api.PageResult;
import com.helmglass.command.infrastructure.repository.CommandRepository;
import com.helmglass.continuation.application.TaskContinuationService;
import com.helmglass.identity.domain.AuthenticatedActor;
import com.helmglass.identity.infrastructure.repository.IdentityRepository;
import com.helmglass.operation.domain.MutationReceipt;
import com.helmglass.operation.infrastructure.repository.OperationRepository;
import com.helmglass.realtime.infrastructure.repository.ChangeRepository;
import com.helmglass.task.api.ResultContracts;
import com.helmglass.task.infrastructure.repository.ResultRepository;
import java.net.URI;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ResultService {
  private final ResultRepository results;
  private final CommandRepository tasks;
  private final IdentityRepository identities;
  private final OperationRepository operations;
  private final ChangeRepository changes;
  private final JsonSupport json;
  private final TaskContinuationService continuations;

  public ResultService(ResultRepository results, CommandRepository tasks,
      IdentityRepository identities, OperationRepository operations, ChangeRepository changes,
      JsonSupport json, TaskContinuationService continuations) {
    this.results = results;
    this.tasks = tasks;
    this.identities = identities;
    this.operations = operations;
    this.changes = changes;
    this.json = json;
    this.continuations = continuations;
  }

  @Transactional
  public MutationReceipt publish(AuthenticatedActor actor, UUID taskId,
      ResultContracts.Publish input, MutationContext context) {
    actor.requireScope("results:write");
    identities.lockActive(actor.userId());
    var task = tasks.lockTask(actor.userId(), taskId);
    var replay = operations.replay(actor, "results.publish:" + taskId, context, input);
    if (replay.isPresent()) {
      return replay.get();
    }
    DomainException.requireVersion(task.version(), input.expectedTaskVersion());
    DomainException.requireVersion(task.instructionRevision(), input.instructionRevision());
    Map<String, String> columns = new LinkedHashMap<>();
    for (var column : input.columns()) {
      if (columns.putIfAbsent(column.key(), column.type()) != null
          || !Set.of("TEXT", "NUMBER", "BOOLEAN", "DATE", "URL").contains(column.type())) {
        throw new DomainException(422, "INVALID_COLUMNS", "Result columns are invalid");
      }
    }
    for (var row : input.rows()) {
      if (!columns.keySet().equals(row.keySet()) || json.write(row).length() > 32768) {
        throw new DomainException(422, "INVALID_RESULT_ROW", "Result row does not match columns");
      }
      columns.forEach((key, type) -> validateCell(type, row.get(key)));
    }
    for (var source : input.sources()) {
      validateCell("URL", source.url());
    }
    if (input.artifactIds().size() != input.artifactIds().stream().distinct().count()) {
      throw new DomainException(422, "DUPLICATE_ARTIFACT", "Result files must be unique");
    }
    continuations.consume(actor, taskId, task.instructionRevision(), input.continuationClaimId());
    var published = results.insert(taskId, input);
    changes.changed(actor.userId(), "result", published.id(), published.revision());
    return operations.save(actor, "results.publish:" + taskId, context, input, "result",
        published.id(), published.revision(), true);
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public Map<String, Object> latest(AuthenticatedActor actor, UUID taskId) {
    actor.requireScope("tasks:read");
    return results.latest(actor.userId(), taskId);
  }

  @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
  public PageResult<Map<String, Object>> rows(AuthenticatedActor actor, UUID resultId,
      PageQuery query) {
    actor.requireScope("tasks:read");
    return results.rows(actor.userId(), resultId, query);
  }

  @Transactional(readOnly = true)
  public Map<String, Object> row(AuthenticatedActor actor, UUID resultId, UUID rowId) {
    actor.requireScope("tasks:read");
    return results.row(actor.userId(), resultId, rowId);
  }

  private static void validateCell(String type, Object value) {
    if (value == null) {
      return;
    }
    boolean valid = switch (type) {
      case "TEXT" -> value instanceof String text && text.length() <= 16384;
      case "NUMBER" -> value instanceof Number number && Double.isFinite(number.doubleValue());
      case "BOOLEAN" -> value instanceof Boolean;
      case "DATE" -> value instanceof String text && validDate(text);
      case "URL" -> value instanceof String text && validUrl(text);
      default -> false;
    };
    if (!valid) {
      throw new DomainException(422, "INVALID_RESULT_VALUE",
          "Result value does not match its type");
    }
  }

  private static boolean validDate(String value) {
    try {
      return LocalDate.parse(value).toString().equals(value);
    } catch (DateTimeException error) {
      return false;
    }
  }

  private static boolean validUrl(String value) {
    try {
      URI uri = URI.create(value);
      return value.length() <= 2048 && uri.getHost() != null && uri.getUserInfo() == null
          && Set.of("https", "http").contains(uri.getScheme());
    } catch (IllegalArgumentException error) {
      return false;
    }
  }
}
