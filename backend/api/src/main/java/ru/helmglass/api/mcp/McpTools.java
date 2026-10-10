package ru.helmglass.api.mcp;

import io.modelcontextprotocol.common.McpTransportContext;
import io.modelcontextprotocol.server.McpServerFeatures.SyncResourceSpecification;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.McpSyncServerExchange;
import io.modelcontextprotocol.spec.McpSchema;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.Contracts;
import ru.helmglass.api.Idempotency;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.ListQuery;
import ru.helmglass.api.artifacts.ArtifactService;
import ru.helmglass.api.audio.AudioAnalysisService;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import ru.helmglass.api.browsers.BrowserService;
import ru.helmglass.api.connections.ConnectionService;
import ru.helmglass.api.tasks.ActionService;
import ru.helmglass.api.tasks.TaskQueries;
import ru.helmglass.api.tasks.TaskService;
import ru.helmglass.api.tasks.TaskStepService;
import tools.jackson.databind.JsonNode;

@Service
public class McpTools {
  private static final Logger log = LoggerFactory.getLogger(McpTools.class);
  private static final int IMAGE_LIMIT = 8 * 1024 * 1024;
  private static final int WIDGET_LIMIT = 1024 * 1024;
  static final String WIDGET_PRESENTATION_INSTRUCTIONS =
      "Обновляемая карточка задачи Helm Glass с просмотром того же браузера."
          + " Текущие статус задачи, состояние браузера, прогресс и ожидание показывайте"
          + " только в обновляемом виджете. Не добавляйте статические статусные плашки,"
          + " бейджи, заголовки или дубли текущего состояния в текст ответа ChatGPT:"
          + " они сохраняются в истории чата и устаревают. После карточки допустимы"
          + " подтверждённый итог и необходимые пояснения; прежнее ожидание описывайте"
          + " как прошлое событие, а не как текущий статус.";
  private final Identity identity;
  private final TaskService tasks;
  private final TaskStepService steps;
  private final TaskQueries queries;
  private final ActionService actions;
  private final BrowserService browsers;
  private final ConnectionService connections;
  private final ArtifactService artifacts;
  private final AudioAnalysisService audioAnalyses;
  private final ChatBindings chats;
  private final TaskElicitation elicitation;
  private final Idempotency idempotency;
  private final JsonSupport json;
  private final JdbcClient jdbc;
  private final String publicUrl;
  private final String widgetUri;
  private final String widgetHtml;

  public McpTools(
      Identity identity,
      TaskService tasks,
      TaskStepService steps,
      TaskQueries queries,
      ActionService actions,
      BrowserService browsers,
      ConnectionService connections,
      ArtifactService artifacts,
      AudioAnalysisService audioAnalyses,
      ChatBindings chats,
      TaskElicitation elicitation,
      Idempotency idempotency,
      JsonSupport json,
      JdbcClient jdbc,
      @Value("${helm.public-url}") String publicUrl) {
    this.identity = identity;
    this.tasks = tasks;
    this.steps = steps;
    this.queries = queries;
    this.actions = actions;
    this.browsers = browsers;
    this.connections = connections;
    this.artifacts = artifacts;
    this.audioAnalyses = audioAnalyses;
    this.chats = chats;
    this.elicitation = elicitation;
    this.idempotency = idempotency;
    this.json = json;
    this.jdbc = jdbc;
    this.publicUrl = publicUrl;
    try (var stream = new ClassPathResource("mcp-widget/index.html").getInputStream()) {
      byte[] bytes = stream.readNBytes(WIDGET_LIMIT + 1);
      if (bytes.length > WIDGET_LIMIT) {
        throw new IOException("Widget resource exceeds its bound");
      }
      widgetHtml = new String(bytes, StandardCharsets.UTF_8);
      String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
      // Hosts cache UI resources by URI, independently of the current tool result.
      widgetUri = "ui://helmglass/task-" + digest + ".html";
    } catch (IOException | NoSuchAlgorithmException exception) {
      throw new IllegalStateException("Widget resource unavailable", exception);
    }
  }

  public List<SyncToolSpecification> specifications() {
    Map<String, Object> task = Map.of("taskId", uuid());
    Map<String, Object> presentation = Map.of("taskId", uuid(), "generation", uuid());
    List<SyncToolSpecification> result = new ArrayList<>();
    result.add(
        tool(
            "tasks.list",
            "Список собственных задач с точным количеством и страницей.",
            listSchema(),
            true,
            false));
    result.add(
        tool(
            "connections.list",
            "Собственные подключения сайтов, включая поддомены одного домена сайта."
                + " Секреты не возвращаются; наличие подключения не доказывает доступ к странице.",
            listSchema(),
            true,
            false));
    result.add(
        tool(
            "connections.select",
            "Выбрать собственное подключение. Выполняйте автономно в рамках поручения;"
                + " подключение подходит для домена сайта и его поддоменов. Открывайте ссылки"
                + " инструкции в том же браузере; проверяйте фактический доступ по странице."
                + " confirmationPrompt задавайте только если переключение требует решения"
                + " пользователя.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "connectionId",
                    uuid(),
                    "confirmationPrompt",
                    text(4000),
                    "operationKey",
                    key(),
                    "instructionRevision",
                    Map.of("type", "integer", "minimum", 1)),
                "taskId",
                "connectionId",
                "operationKey",
                "instructionRevision"),
            false,
            false));
    result.add(
        tool(
            "tasks.get",
            "Актуальное поручение, состояние, вопросы и результаты собственной задачи. lastResponse"
                + " содержит последний принятый ответ или результат проверки для текущей ревизии."
                + " UNKNOWN_RESULT в нём означает проверку моделью, а не согласие человека."
                + " WAITING_CHATGPT / UNKNOWN_RESULT требует самостоятельной проверки: выполните"
                + " browser.execute observe, даже при CLOSED. Передайте через tasks.respond"
                + " verification SUCCEEDED, FAILED либо UNCONFIRMED с основанием безопасного"
                + " продолжения без повтора прежнего действия. Согласие человека не требуется."
                + " По просьбе продолжить разрешён повторный RESUME для той же проверки.",
            object(task, "taskId"),
            true,
            false));
    result.add(
        tool(
            "artifacts.list",
            "Сохранённые файлы собственной задачи: готовность, целостность, точное количество и"
                + " страница.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "page",
                    Map.of("type", "integer", "minimum", 1),
                    "pageSize",
                    Map.of("type", "integer", "enum", List.of(10, 20, 50))),
                "taskId"),
            true,
            false));
    result.add(
        tool(
            "tasks.create",
            "Создать новую самостоятельную задачу только по явному поручению пользователя и связать"
                + " с исходным чатом. Вызывайте сразу по поручению, до вступительного текста,"
                + " проверки подключений, страниц, шагов и аудио. После получения карточки"
                + " продолжайте выполнение. Уточнения продолжают прежний taskId. Возвращает"
                + " единственную"
                + " карточку этого ответа: дополнительный tasks.view не нужен. Первую браузерную"
                + " команду отправляйте с описанием step: отдельные DECLARE и START не нужны.",
            object(
                Map.of(
                    "operationKey",
                    key(),
                    "task",
                    object(
                        Map.of(
                            "title",
                            text(200),
                            "goal",
                            text(20000),
                            "startUrl",
                            text(4096),
                            "outputFormat",
                            choice("TEXT", "TABLE", "REPORT"),
                            "preferredConnectionIds",
                            array(uuid(), 50),
                            "prepare",
                            bool()),
                        "title",
                        "goal")),
                "operationKey",
                "task"),
            false,
            false));
    result.add(
        tool(
            "tasks.view",
            "Обязательно показать новую карточку той же задачи при каждом пользовательском"
                + " уточнении или поручении выполнить либо продолжить задачу."
                + " Вызывайте сразу после минимального поиска и tasks.get либо первой tasks.bind,"
                + " до вступительного текста, AMEND и основной работы. Прежние карточки становятся"
                + " неактивными; taskId, браузер, история и результаты сохраняются."
                + " Только один раз за ответ; tasks.create уже показывает карточку."
                + " При автоматическом продолжении не вызывать: прежний виджет обновляется"
                + " событиями."
                + " Новое сообщение пользователя с уточнением не является автоматическим"
                + " продолжением."
                + " Не привязывает и не запускает задачу.",
            object(Map.of("taskId", uuid(), "operationKey", key()), "taskId", "operationKey"),
            false,
            false));
    result.add(
        tool(
            "tasks.bind",
            "По явному поручению связать задачу кабинета с этим чатом и подготовить её браузер."
                + " Затем показать tasks.view.",
            object(Map.of("taskId", uuid(), "operationKey", key()), "taskId", "operationKey"),
            false,
            false));
    result.add(
        tool(
            "steps.list",
            "Прочитать отдельные вызовы инструментов агента. Каждый вызов записывает сервер.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "page",
                    Map.of("type", "integer", "minimum", 1),
                    "search",
                    text(300),
                    "beforeSequence",
                    Map.of("type", "integer", "minimum", 1)),
                "taskId"),
            true,
            false));
    result.add(
        tool(
            "widget.steps",
            "Вызовы инструментов агента в актуальном виджете; обновления виджета не считаются шагами.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "generation",
                    uuid(),
                    "page",
                    Map.of("type", "integer", "minimum", 1),
                    "search",
                    Map.of("type", "string", "maxLength", 1000),
                    "beforeSequence",
                    Map.of("type", "integer", "minimum", 1)),
                "taskId",
                "generation"),
            true,
            false));
    result.add(
        tool(
            "tasks.command",
            "Изменить поручение или жизненный цикл задачи. Перед AMEND по новому уточнению"
                + " пользователя обязательно покажите tasks.view с тем же taskId один раз в этом"
                + " ответе: AMEND сам новую карточку не показывает. STOP окончателен;"
                + " RESUME завершённой задачи допускается только по явной просьбе пользователя"
                + " в свободном исходном чате. REQUIRE_LOGIN приостанавливает задачу"
                + " и показывает «Войти на сайт» в"
                + " текущем виджете. Кнопка открывает подключение в Helm Glass; отсутствующее"
                + " подключение создаётся автоматически. Для LOGIN не вызывайте tasks.respond:"
                + " нативная форма не нужна. После «Завершить вход» виджет запрашивает продолжение"
                + " той же задачи в исходном чате. FINISH с SUCCEEDED закрывает браузер;"
                + " подтверждайте CLOSED через tasks.get. При FINISH command.text заменяет"
                + " result.summary: передайте полный итог с полученными данными, а не сообщение"
                + " «результат сохранён». Ответы на вопросы и согласие пользователя принимаются"
                + " только через tasks.respond. После принятого RESUME выполните browser.execute"
                + " observe: первое чтение создаст отсутствующий браузер. При UNKNOWN_RESULT"
                + " повторный RESUME разрешает ту же проверку; проверку выполняет модель,"
                + " новое согласие пользователя не требуется. Не создавайте новую задачу"
                + " для обхода ожидания.",
            object(
                Map.of("taskId", uuid(), "operationKey", key(), "command", commandSchema()),
                "taskId",
                "operationKey",
                "command"),
            false,
            false));
    result.add(
        tool(
            "tasks.ask",
            "Запросить решение пользователя только если данных недостаточно или поручение"
                + " противоречиво. Сохраните ожидание, затем вызовите tasks.respond для нативного"
                + " вопроса в этом чате.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "operationKey",
                    key(),
                    "prompt",
                    text(20000),
                    "instructionRevision",
                    Map.of("type", "integer", "minimum", 1)),
                "taskId",
                "operationKey",
                "prompt",
                "instructionRevision"),
            false,
            false));
    result.add(
        tool(
            "tasks.respond",
            "Показать QUESTION, ACCOUNT_CHOICE или CONFIRMATION в нативной форме"
                + " GPT. LOGIN и MANUAL_CONTROL выполняются в Helm Glass через кнопку текущего"
                + " виджета; не вызывайте этот инструмент для входа. Сервер получает ответ напрямую"
                + " от host; не передавайте ответ, согласие или выбор аккаунта аргументами. После"
                + " отмены или таймаута повторный показ допустим только по новому обращению"
                + " пользователя. UNKNOWN_RESULT проверяйте самостоятельно: выполните observe,"
                + " установите результат по состоянию сайта и передайте verification с outcome,"
                + " evidence и observationOperationId успешного наблюдения после действия."
                + " Нативная форма для проверки результата не нужна. Если исход не установлен,"
                + " но продолжение безопасно без повтора и без предположения об успехе, передайте"
                + " UNCONFIRMED и обоснование в evidence. Промежуточный клик по плееру"
                + " не должен блокировать остальные действия. Иначе сохраните UNKNOWN;"
                + " не угадывайте и не повторяйте отправку с возможным внешним эффектом.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "requestId",
                    uuid(),
                    "requestVersion",
                    Map.of("type", "integer", "minimum", 1),
                    "operationKey",
                    key(),
                    "verification",
                    object(
                        Map.of(
                            "outcome", choice("SUCCEEDED", "FAILED", "UNCONFIRMED"),
                            "evidence", text(4000),
                            "observationOperationId", uuid()),
                        "outcome",
                        "evidence",
                        "observationOperationId")),
                "taskId",
                "requestId",
                "requestVersion",
                "operationKey"),
            false,
            false));
    result.add(
        tool(
            "browser.execute",
            "Выполнить action или последовательность actions (до 8). Один вызов — один шаг агента."
                + " click/fill/check/selectOption требуют в arguments одновременно"
                + " observationId и ref из выданного наблюдения; одного ref недостаточно."
                + " Для видимой кнопки без ARIA ref click принимает вместо них {screenshotId,x,y}"
                + " из свежего screenshot: координаты в CSS-пикселях исходного изображения."
                + " screenshotTarget действует 60 секунд до следующего действия, смены страницы"
                + " или управления. Не объединяйте координатные клики в пакет по одному снимку."
                + " snapshot содержит native ARIA nodes с path; observe.arguments: {} — страница,"
                + " {observationId,ref} — область, {cursor} — продолжение; варианты несовместимы."
                + " scope определяет область полноты. Адресный observe может завершать пакет."
                + " press.arguments: {key}; клавиша действует на текущий фокус. waitFor.arguments:"
                + " text, textGone (1–1000 символов) и/или time (секунды, больше 0, не более 30)."
                + " Ожидания выполняет штатный MCP на странице. Отсутствующие checked/selected"
                + " означают false. selectOption принимает видимые названия options. Условные поля"
                + " ищите в новом observation. Короткие команды возвращают готовый результат;"
                + " только для ACCEPTED/DISPATCHED или потерянного ответа нужен operations.get."
                + " После изменения страницы возвращается observation: используйте её вместо"
                + " отдельного observe. listMedia, captureAudio и screenshot по умолчанию"
                + " возвращают только свой результат. Шаг сохраняется автоматически. Группируйте заранее"
                + " известные независимые заполнения в actions; не объединяйте действия, требующие"
                + " промежуточного решения. Каждый элемент имеет свой стабильный operationId."
                + " Последовательность останавливается на первом неподтверждённом успехе;"
                + " complete=false и nextOperationId требуют проверки. confirmationPrompt"
                + " указывайте только если конкретный шаг требует решения пользователя: задайте"
                + " этот вопрос в чате, получите ответ через tasks.respond с"
                + " requestId/requestVersion. operationId сохраняется при повторе; при потере"
                + " ответа запрашивать operations.get. Не передавать пароли и коды: вход"
                + " выполняется в кабинете. captureAudio требует sourceId из listMedia, sourceRef и"
                + " sourceContext с идентификатором задания, точной инструкцией и вопросами."
                + " listMedia может содержать звуки уведомлений и медиа других страниц. До"
                + " captureAudio сопоставьте источник с нужным сообщением через его плеер;"
                + " sourceRef сам по себе не подтверждает это соответствие.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "action",
                    actionSchema(),
                    "actions",
                    array(actionSchema(), 8)),
                "taskId"),
            false,
            true));
    result.add(
        tool(
            "operations.list",
            "Найти ранее отправленные операции задачи или шага агента после восстановления"
                + " контекста. Возвращает идентификаторы и состояния, по 10 записей. Результат"
                + " читать через operations.get; неизвестное действие не повторять.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "stepId",
                    uuid(),
                    "page",
                    Map.of("type", "integer", "minimum", 1, "maximum", 1000000)),
                "taskId"),
            true,
            false));
    result.add(
        tool(
            "operations.get",
            "Проверить исход операции после ACCEPTED/DISPATCHED или потери ответа. Если"
                + " browser.execute уже вернул SUCCEEDED и результат, повторное чтение не нужно.",
            object(Map.of("operationId", uuid()), "operationId"),
            true,
            false));
    result.add(
        tool(
            "audio.analyze",
            "Запустить локальный анализ собственного сохранённого аудио. Для текста"
                + " mode=transcript; для звучания mode=full. Повтор переиспользует анализ,"
                + " повышение режима сохраняет расшифровку. Ожидает до 8 секунд и возвращает первую"
                + " страницу transcript с items, sectionComplete, hasMore и nextCursor. Используйте"
                + " готовые items сразу; audio.get нужен только для незавершённого анализа,"
                + " следующих страниц или других разделов. Доступен из любого своего чата без"
                + " передачи управления задачей.",
            object(
                Map.of(
                    "artifactId",
                    uuid(),
                    "mode",
                    Map.of("type", "string", "enum", List.of("transcript", "full"))),
                "artifactId",
                "mode"),
            false,
            false));
    result.add(
        tool(
            "audio.get",
            "Прочитать состояние и текстовые результаты локального анализа. Разделы: transcript,"
                + " intervals, acoustics, emotions. Прочитайте все страницы по nextCursor/hasMore;"
                + " sectionComplete отдельно показывает полноту стадии. PARTIAL/FAILED не являются"
                + " полным успехом. Аудиофайл модели не передаётся.",
            object(
                Map.of(
                    "analysisId",
                    uuid(),
                    "section",
                    Map.of(
                        "type",
                        "string",
                        "enum",
                        List.of("transcript", "intervals", "acoustics", "emotions")),
                    "cursor",
                    Map.of("type", "string", "pattern", "^[0-9]{1,19}$"),
                    "limit",
                    Map.of("type", "integer", "minimum", 1, "maximum", 100)),
                "analysisId"),
            true,
            false));
    result.add(
        tool(
            "results.publish",
            "Сохранить вывод, источники, файлы и строки таблицы порцией до 100. Частичный результат"
                + " явно описывает ограничения; не завершает задачу.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "operationKey",
                    key(),
                    "result",
                    resultSchema(),
                    "instructionRevision",
                    Map.of("type", "integer", "minimum", 1),
                    "rows",
                    array(Map.of("type", "object", "maxProperties", 100), 100)),
                "taskId",
                "operationKey",
                "result",
                "instructionRevision"),
            false,
            false));
    result.add(
        tool(
            "widget.state",
            "Прочитать состояние текущего поколения. Для устаревшего поколения возвращается"
                + " только {code: STALE_WIDGET, message}, без данных задачи и нового поколения.",
            object(presentation, "taskId", "generation"),
            true,
            false));
    result.add(
        tool(
            "widget.keep-open",
            "Продлить браузер на 5 минут ожидания или 15 минут ручного управления без запуска"
                + " задачи.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "generation",
                    uuid(),
                    "browserId",
                    uuid(),
                    "operationKey",
                    key()),
                "taskId",
                "generation",
                "browserId",
                "operationKey"),
            false,
            false));
    result.add(
        tool(
            "widget.claim",
            "Однократно получить право отправить запрос продолжения исходному host.",
            object(
                Map.of("taskId", uuid(), "generation", uuid(), "continuationId", uuid()),
                "taskId",
                "generation",
                "continuationId"),
            false,
            false));
    result.add(
        tool(
            "widget.browser",
            "Получить билет просмотра прежнего браузера. Ручной ввод доступен в кабинете.",
            object(
                Map.of("taskId", uuid(), "generation", uuid(), "viewerId", uuid()),
                "taskId",
                "generation",
                "viewerId"),
            false,
            false));
    result.add(
        tool(
            "widget.continuation",
            "Зафиксировать ответ host на запрос продолжения. Отправка не означает принятия"
                + " следующего шага.",
            object(
                Map.of(
                    "taskId",
                    uuid(),
                    "generation",
                    uuid(),
                    "continuationId",
                    uuid(),
                    "sent",
                    bool(),
                    "reason",
                    text(500)),
                "taskId",
                "generation",
                "continuationId",
                "sent"),
            false,
            false));
    return List.copyOf(result);
  }

  private SyncToolSpecification tool(
      String name,
      String description,
      Map<String, Object> schema,
      boolean readOnly,
      boolean openWorld) {
    if (agentTool(name)) {
      Map<String, Object> properties = new LinkedHashMap<>();
      if (schema.get("properties") instanceof Map<?, ?> supplied) {
        for (var entry : supplied.entrySet()) {
          if (entry.getKey() instanceof String key) {
            properties.put(key, entry.getValue());
          }
        }
      }
      properties.put("callId", uuid());
      List<String> required = new ArrayList<>();
      if (schema.get("required") instanceof List<?> supplied) {
        for (Object value : supplied) {
          if (value instanceof String key) {
            required.add(key);
          }
        }
      }
      required.add("callId");
      schema = new LinkedHashMap<>(schema);
      schema.put("properties", properties);
      schema.put("required", required);
      description += " callId — новый UUID каждого вызова; после потери ответа повторяйте"
          + " тот же callId и аргументы. Шаг и длительность сохраняет сервер автоматически.";
    }
    Map<String, Object> metadata = new LinkedHashMap<>();
    metadata.put(
        "securitySchemes",
        List.of(Map.of("type", "oauth2", "scopes", List.of("openid", "offline_access"))));
    if (Set.of("tasks.view", "tasks.create").contains(name)) {
      metadata.put("ui", Map.of("resourceUri", widgetUri));
      description = description + " " + WIDGET_PRESENTATION_INSTRUCTIONS;
    } else if (name.startsWith("widget.")) {
      metadata.put("ui", Map.of("visibility", List.of("app")));
    }
    var builder =
        McpSchema.Tool.builder(name, schema)
            .description(description)
            .annotations(
                McpSchema.ToolAnnotations.builder()
                    .readOnlyHint(readOnly)
                    .destructiveHint(
                        Set.of("browser.execute", "tasks.command", "tasks.respond").contains(name))
                    .openWorldHint(openWorld)
                    .idempotentHint(true)
                    .build())
            .meta(metadata);
    if ("widget.state".equals(name)) {
      builder.outputSchema(McpSchemas.widgetState());
    } else if (Set.of("tasks.create", "tasks.view", "widget.continuation").contains(name)) {
      builder.outputSchema(McpSchemas.presentation());
    }
    return new SyncToolSpecification(
        builder.build(), (exchange, request) -> measuredCall(name, exchange, request));
  }

  private static boolean agentTool(String name) {
    return !name.startsWith("widget.") && !Set.of("tasks.list", "connections.list").contains(name);
  }

  private static String callTitle(String tool, JsonNode input) {
    if ("browser.execute".equals(tool)) {
      if (input.has("actions")) {
        return "Выполнить действия в браузере · " + input.path("actions").size();
      }
      return switch (input.path("action").path("type").asString()) {
        case "navigate" -> "Открыть страницу";
        case "observe" -> "Прочитать страницу";
        case "click" -> "Нажать элемент";
        case "fill" -> "Заполнить поле";
        case "press" -> "Нажать клавишу";
        case "selectOption" -> "Выбрать значение";
        case "check" -> "Изменить отметку";
        case "scroll" -> "Прокрутить страницу";
        case "goBack" -> "Вернуться на предыдущую страницу";
        case "newTab" -> "Открыть вкладку";
        case "selectTab" -> "Выбрать вкладку";
        case "closeTab" -> "Закрыть вкладку";
        case "screenshot" -> "Получить снимок";
        case "listMedia" -> "Найти медиа на странице";
        case "captureAudio" -> "Сохранить аудио";
        case "waitFor" -> "Дождаться изменения страницы";
        default -> "Выполнить действие в браузере";
      };
    }
    return switch (tool) {
      case "tasks.create" -> "Создать задачу";
      case "tasks.bind" -> "Связать задачу с чатом";
      case "tasks.view" -> "Показать задачу";
      case "tasks.get" -> "Прочитать состояние задачи";
      case "tasks.command" -> "Изменить состояние задачи";
      case "tasks.ask" -> "Запросить ответ пользователя";
      case "tasks.respond" -> "Получить ответ или проверить результат";
      case "steps.list" -> "Прочитать шаги";
      case "operations.list" -> "Прочитать список операций";
      case "operations.get" -> "Проверить операцию";
      case "connections.select" -> "Выбрать подключение";
      case "artifacts.list" -> "Прочитать список файлов";
      case "audio.analyze" -> "Распознать и проанализировать аудио";
      case "audio.get" -> "Прочитать результат анализа аудио";
      case "results.publish" -> "Сохранить результат задачи";
      default -> tool;
    };
  }

  private McpSchema.CallToolResult measuredCall(
      String tool, McpSyncServerExchange exchange, McpSchema.CallToolRequest request) {
    UUID logId = UUID.randomUUID();
    long started = System.nanoTime();
    String outcome = "ERROR";
    UUID task = null;
    try {
      Actor actor = actor(exchange.transportContext());
      JsonNode input = json.tree(request.arguments() == null ? Map.of() : request.arguments());
      UUID callId = null;
      if (agentTool(tool)) {
        callId = uuid(input, "callId");
        if (!"tasks.create".equals(tool)) {
          task = steps.taskForCall(actor.id(), input);
          if (task == null) {
            throw ApiException.invalid("taskId", "Укажите ресурс задачи.");
          }
          steps.begin(actor.id(), task, callId, tool, callTitle(tool, input), input);
        }
      }
      McpSchema.CallToolResult result = call(actor, exchange, request, callId);
      boolean failed = Boolean.TRUE.equals(result.isError());
      if (callId != null) {
        steps.finish(actor.id(), callId, failed,
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
      }
      outcome = failed ? "ERROR" : "OK";
      return result;
    } catch (ApiException exception) {
      return McpSchema.CallToolResult.builder().isError(true)
          .structuredContent(exception.response())
          .addTextContent(json.write(exception.response())).build();
    } catch (IllegalArgumentException exception) {
      return McpSchema.CallToolResult.builder().isError(true)
          .addTextContent("Некорректный запрос инструмента.").build();
    } finally {
      log.info("MCP_CALL id={} tool={} task={} durationMs={} outcome={}",
          logId, tool, task, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started), outcome);
    }
  }

  private McpSchema.CallToolResult call(
      Actor actor, McpSyncServerExchange exchange, McpSchema.CallToolRequest request, UUID callId) {
    try {
      Map<String, Object> arguments = new LinkedHashMap<>(
          request.arguments() == null ? Map.of() : request.arguments());
      arguments.remove("callId");
      JsonNode input = json.tree(arguments);
      UUID owner = actor.id();
      String name = request.name();
      if ("tasks.respond".equals(name)
          && !arguments
              .keySet()
              .equals(Set.of("taskId", "requestId", "requestVersion", "operationKey"))
          && !arguments
              .keySet()
              .equals(
                  Set.of(
                      "taskId", "requestId", "requestVersion", "operationKey", "verification"))) {
        throw ApiException.invalid(
            "arguments", "Ответ пользователя нельзя передать аргументами модели.");
      }
      if ("tasks.list".equals(name)) {
        return textResult(tasks.list(owner, listQuery(arguments)));
      }
      if ("connections.list".equals(name)) {
        return textResult(connections.list(owner, listQuery(arguments)));
      }
      if ("operations.list".equals(name)) {
        return textResult(
            actions.list(
                owner,
                uuid(input, "taskId"),
                input.has("stepId") ? uuid(input, "stepId") : null,
                listQuery(arguments).page()));
      }
      if ("operations.get".equals(name)) {
        UUID operationId = uuid(input, "operationId");
        return operation(owner, operationId);
      }
      if ("tasks.get".equals(name)) {
        return textResult(tasks.get(owner, uuid(input, "taskId")));
      }
      if ("artifacts.list".equals(name)) {
        return textResult(artifacts.list(owner, uuid(input, "taskId"), listQuery(arguments)));
      }
      if ("audio.get".equals(name)) {
        if (!Set.of("analysisId", "section", "cursor", "limit").containsAll(arguments.keySet())) {
          throw ApiException.invalid("arguments", "Недопустимые параметры audio.get.");
        }
        return textResult(
            audioAnalyses.page(
                owner,
                uuid(input, "analysisId"),
                input.path("section").asString("transcript"),
                Long.parseLong(input.path("cursor").asString("0")),
                input.path("limit").asInt(100),
                null,
                null));
      }
      if ("audio.analyze".equals(name)) {
        if (!arguments.keySet().equals(Set.of("artifactId", "mode"))) {
          throw ApiException.invalid("arguments", "Требуются artifactId и mode.");
        }
        return textResult(
            audioAnalyses.analyzeAndRead(owner, uuid(input, "artifactId"), string(input, "mode")));
      }
      if ("steps.list".equals(name)) {
        var values = new LinkedMultiValueMap<String, String>();
        for (String field : List.of("page", "search", "beforeSequence")) {
          if (input.has(field)) values.add(field, input.path(field).asString());
        }
        return textResult(steps.list(owner, uuid(input, "taskId"), values));
      }
      String chat = ChatBindings.chatId(request.meta());
      if ("tasks.create".equals(name)) {
        var created =
            idempotency.execute(
                owner,
                string(input, "operationKey"),
                name,
                Map.of("arguments", arguments, "chatId", chat),
                Presentation.class,
                () -> {
                  Contracts.TaskInput requested =
                      json.convert(input.path("task"), Contracts.TaskInput.class);
                  Contracts.Task task =
                      tasks.create(
                          owner,
                          new Contracts.TaskInput(
                              requested.title(),
                              requested.goal(),
                              requested.startUrl(),
                              requested.outputFormat(),
                              requested.preferredConnectionIds(),
                              requested.prepare() == null || requested.prepare()),
                          "MCP");
                  steps.begin(owner, task.id(), callId, name, "Создать задачу",
                      json.tree(request.arguments()));
                  chats.bind(owner, task.id(), chat);
                  actions.prepareBrowser(owner, task.id());
                  return data(owner, chats.show(owner, task.id(), chat));
                });
        return presentation(created);
      }
      UUID taskId = uuid(input, "taskId");
      if ("tasks.view".equals(name)) {
        return presentation(
            idempotency.execute(
                owner,
                string(input, "operationKey"),
                name,
                Map.of("arguments", arguments, "chatId", chat),
                Presentation.class,
                () -> data(owner, chats.show(owner, taskId, chat))));
      }
      if ("tasks.bind".equals(name)) {
        return textResult(
            idempotency.execute(
                owner,
                string(input, "operationKey"),
                name,
                Map.of("arguments", arguments, "chatId", chat),
                Contracts.Task.class,
                () -> {
                  chats.bind(owner, taskId, chat);
                  return actions.prepareBrowser(owner, taskId);
                }));
      }
      chats.requireOriginal(owner, taskId, chat);
      if (Set.of(
                  "browser.execute",
                  "connections.select",
                  "tasks.ask",
                  "results.publish")
              .contains(name)
          || "tasks.command".equals(name)
              && !Set.of("RESUME", "STOP")
                  .contains(input.path("command").path("type").asString())) {
        chats.requireCurrent(owner, taskId, chat);
      }
      return switch (name) {
        case "tasks.respond" ->
            textResult(
                elicitation.respond(
                    exchange,
                    actor,
                    chat,
                    taskId,
                    uuid(input, "requestId"),
                    input.path("requestVersion").asLong(),
                    string(input, "operationKey"),
                    input.has("verification") ? verification(input.path("verification")) : null));
        case "connections.select" ->
            textResult(
                idempotency.execute(
                    owner,
                    string(input, "operationKey"),
                    name,
                    arguments,
                    Contracts.Task.class,
                    () -> {
                      chats.acceptCommand(owner, taskId, chat);
                      return actions.selectConnection(
                          owner,
                          taskId,
                          input.path("instructionRevision").asLong(),
                          uuid(input, "connectionId"),
                          input.path("confirmationPrompt").asString(null));
                    }));
        case "tasks.command" -> {
          Contracts.TaskCommand command =
              json.convert(input.path("command"), Contracts.TaskCommand.class);
          yield textResult(
              idempotency.execute(
                  owner,
                  string(input, "operationKey"),
                  name,
                  arguments,
                  Contracts.Task.class,
                  () -> {
                    boolean reopensContinuation =
                        Set.of("RESUME", "AMEND").contains(command.type());
                    if (!reopensContinuation && !"STOP".equals(command.type())) {
                      chats.acceptCommand(owner, taskId, chat);
                    }
                    Contracts.Task result =
                        "REQUIRE_LOGIN".equals(command.type())
                            ? browsers.requireLogin(owner, taskId, command.expectedVersion())
                            : tasks.command(actor, taskId, command);
                    if ("PREPARE".equals(command.type())) {
                      result = actions.prepareBrowser(owner, taskId);
                    }
                    if (reopensContinuation) {
                      chats.acceptCommand(owner, taskId, chat);
                    }
                    return result;
                  }));
        }
        case "tasks.ask" ->
            textResult(
                idempotency.execute(
                    owner,
                    string(input, "operationKey"),
                    name,
                    arguments,
                    Contracts.Task.class,
                    () -> {
                      chats.acceptCommand(owner, taskId, chat);
                      tasks.ask(
                          owner,
                          taskId,
                          input.path("instructionRevision").asLong(),
                          string(input, "prompt"),
                          null);
                      return tasks.get(owner, taskId);
                    }));
        case "browser.execute" -> execute(owner, taskId, chat, input, callId);
        case "results.publish" ->
            textResult(
                idempotency.execute(
                    owner,
                    string(input, "operationKey"),
                    name,
                    arguments,
                    Contracts.Task.class,
                    () -> {
                      chats.acceptCommand(owner, taskId, chat);
                      List<JsonNode> rows = new ArrayList<>();
                      input.path("rows").forEach(rows::add);
                      actions.saveResult(
                          owner,
                          taskId,
                          input.path("instructionRevision").asLong(),
                          input.path("result"),
                          rows);
                      return tasks.get(owner, taskId);
                    }));
        case "widget.state" ->
            presentation(data(owner, chats.state(owner, taskId, chat, uuid(input, "generation"))));
        case "widget.steps" -> {
          chats.state(owner, taskId, chat, uuid(input, "generation"));
          var values = new LinkedMultiValueMap<String, String>();
          values.add("page", String.valueOf(input.path("page").asInt(1)));
          if (input.has("search")) values.add("search", input.path("search").asString());
          if (input.has("beforeSequence")) {
            values.add("beforeSequence", input.path("beforeSequence").asString());
          }
          yield textResult(steps.list(owner, taskId, values));
        }
        case "widget.claim" ->
            textResult(
                Map.of(
                    "claimed",
                    chats.claim(
                        owner,
                        taskId,
                        chat,
                        uuid(input, "generation"),
                        uuid(input, "continuationId"))));
        case "widget.keep-open" -> {
          UUID generation = uuid(input, "generation");
          var state = data(owner, chats.state(owner, taskId, chat, generation));
          UUID browserId = uuid(input, "browserId");
          if (state.task().browser() == null || !browserId.equals(state.task().browser().id())) {
            throw ApiException.conflict("BROWSER_UNAVAILABLE", "Браузер задачи изменился.");
          }
          idempotency.execute(
              owner,
              string(input, "operationKey"),
              name,
              arguments,
              Contracts.Browser.class,
              () -> browsers.keepOpen(owner, browserId));
          yield presentation(data(owner, chats.state(owner, taskId, chat, generation)));
        }
        case "widget.browser" -> {
          var state = data(owner, chats.state(owner, taskId, chat, uuid(input, "generation")));
          if (state.task().browser() == null) {
            throw ApiException.conflict("NO_BROWSER", "Браузер ещё не открыт.");
          }
          yield textResult(
              browsers.ticket(
                  actor,
                  state.task().browser().id(),
                  new Contracts.TicketInput("VIEWER", string(input, "viewerId"))));
        }
        case "widget.continuation" ->
            presentation(
                data(
                    owner,
                    chats.reported(
                        owner,
                        taskId,
                        chat,
                        uuid(input, "generation"),
                        uuid(input, "continuationId"),
                        input.path("sent").asBoolean(),
                        input.path("reason").asString(null))));
        default -> throw ApiException.invalid("name", "Неизвестный инструмент.");
      };
    } catch (ApiException exception) {
      Map<String, Object> failure = exception.response();
      if ("widget.state".equals(request.name()) && "STALE_WIDGET".equals(exception.code())) {
        failure = Map.of("code", exception.code(), "message", exception.getMessage());
        return McpSchema.CallToolResult.builder()
            .isError(false)
            .structuredContent(failure)
            .addTextContent(json.write(failure))
            .build();
      }
      return McpSchema.CallToolResult.builder()
          .isError(true)
          .structuredContent(failure)
          .addTextContent(json.write(failure))
          .build();
    } catch (IllegalArgumentException exception) {
      return McpSchema.CallToolResult.builder()
          .isError(true)
          .addTextContent("Некорректный запрос инструмента.")
          .build();
    } catch (RuntimeException exception) {
      // The SDK logs propagated messages; database and transport errors may contain private data.
      log.error("MCP tool failed: {}", exception.getClass().getSimpleName());
      return McpSchema.CallToolResult.builder()
          .isError(true)
          .addTextContent(
              json.write(
                  Map.of(
                      "code", "SERVICE_ERROR",
                      "message", "Не удалось выполнить запрос. Проверьте сохранённое состояние.")))
          .build();
    }
  }

  private Actor actor(McpTransportContext context) {
    if (!(context.get("jwt") instanceof Jwt jwt)) {
      throw Identity.denied("Требуется OAuth-доступ ChatGPT.");
    }
    Actor actor = identity.authenticate(jwt);
    if (!"MCP".equals(actor.channel())) {
      throw Identity.denied("Требуется независимый OAuth-доступ ChatGPT.");
    }
    return actor;
  }

  private McpSchema.CallToolResult execute(
      UUID owner, UUID task, String chat, JsonNode input, UUID callId) {
    boolean sequence = input.has("actions");
    if (sequence == input.has("action")) {
      throw ApiException.invalid("action", "Передайте action или actions, но не оба поля.");
    }
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
    if (!sequence) {
      if (!input.path("action").isObject()) {
        throw ApiException.invalid("action", "Действие должно быть объектом.");
      }
      Contracts.BrowserAction action =
          json.convert(input.path("action"), Contracts.BrowserAction.class);
      return operationResponse(
          owner, executeAction(owner, task, chat, action, deadline, List.of(), callId));
    }
    JsonNode supplied = input.path("actions");
    if (!supplied.isArray() || supplied.isEmpty() || supplied.size() > 8) {
      throw ApiException.invalid("actions", "Последовательность содержит от 1 до 8 действий.");
    }
    List<Contracts.BrowserAction> commands = new ArrayList<>();
    Set<UUID> identifiers = new HashSet<>();
    for (JsonNode item : supplied) {
      if (!item.isObject()) {
        throw ApiException.invalid("actions", "Каждое действие должно быть объектом.");
      }
      Contracts.BrowserAction action = json.convert(item, Contracts.BrowserAction.class);
      if (action.operationId() == null || !identifiers.add(action.operationId())) {
        throw ApiException.invalid("operationId", "Каждому действию нужен уникальный operationId.");
      }
      if ("observe".equals(action.type())
          && action.arguments() != null
          && action.arguments().has("ref")
          && commands.size() != supplied.size() - 1) {
        throw ApiException.invalid(
            "actions", "Адресный observe должен завершать последовательность.");
      }
      commands.add(
          new Contracts.BrowserAction(
              action.operationId(),
              action.type(),
              action.arguments(),
              action.instructionRevision(),
              action.controlEpoch(),
              action.confirmationPrompt(),
              action.observeAfter() == null && commands.size() < supplied.size() - 1
                  ? Boolean.FALSE
                  : action.observeAfter()));
    }
    List<UUID> sequenceIds = commands.stream().map(Contracts.BrowserAction::operationId).toList();
    List<Contracts.Operation> completed = new ArrayList<>();
    for (int index = 0; index < commands.size(); index++) {
      Contracts.BrowserAction action = commands.get(index);
      if (!completed.isEmpty() && System.nanoTime() >= deadline) {
        return sequenceResult(
            owner,
            task,
            Map.of(
                "operations",
                completed,
                "complete",
                false,
                "nextOperationId",
                action.operationId()));
      }
      Contracts.Operation result;
      try {
        result = executeAction(owner, task, chat, action, deadline, sequenceIds, callId);
      } catch (ApiException exception) {
        if (completed.isEmpty()) {
          throw exception;
        }
        return sequenceResult(
            owner,
            task,
            Map.of(
                "operations",
                completed,
                "complete",
                false,
                "nextOperationId",
                action.operationId(),
                "error",
                exception.response()));
      }
      completed.add(result);
      if (!"SUCCEEDED".equals(result.status())) {
        return sequenceResult(
            owner,
            task,
            Map.of(
                "operations",
                completed,
                "complete",
                false,
                "nextOperationId",
                action.operationId()));
      }
    }
    return sequenceResult(owner, task, Map.of("operations", completed, "complete", true));
  }

  private McpSchema.CallToolResult sequenceResult(
      UUID owner, UUID task, Map<String, Object> result) {
    actions.requireResultAccess(owner, task);
    return textResult(result);
  }

  private Contracts.Operation executeAction(
      UUID owner,
      UUID task,
      String chat,
      Contracts.BrowserAction action,
      long deadline,
      List<UUID> sequence,
      UUID callId) {
    chats.requireCurrent(owner, task, chat);
    Contracts.Operation result = actions.submit(owner, task, action, sequence, callId);
    if (Set.of("ACCEPTED", "DISPATCHED", "SUCCEEDED").contains(result.status())) {
      chats.accepted(owner, task, chat, action.instructionRevision(), action.operationId());
    }
    return actions.awaitResult(owner, result, deadline);
  }

  private McpSchema.CallToolResult operation(UUID owner, UUID id) {
    Contracts.Operation operation = actions.result(owner, id);
    return operationResponse(owner, operation);
  }

  private McpSchema.CallToolResult operationResponse(UUID owner, Contracts.Operation operation) {
    JsonNode result = operation.result();
    if ("screenshot".equals(operation.type())
        && "SUCCEEDED".equals(operation.status())
        && result != null
        && result.path("artifact").path("id").isString()) {
      UUID artifactId = UUID.fromString(result.path("artifact").path("id").asString());
      var available = artifacts.findReady(owner, artifactId);
      if (available.isEmpty()) {
        return McpSchema.CallToolResult.builder()
            .addTextContent(json.write(modelData(json.tree(operation))))
            .addTextContent(
                "Снимок получен. Доставка файла ещё не подтверждена; проверьте artifacts.list. Не"
                    + " повторяйте действие.")
            .build();
      }
      Contracts.Artifact artifact = available.get();
      return McpSchema.CallToolResult.builder()
          .addTextContent(
              json.write(
                  Map.of(
                      "operationId", operation.id(),
                      "status", operation.status(),
                      "result",
                      Map.of("screenshotTarget", modelData(result.path("screenshotTarget"))))))
          .addContent(
              McpSchema.ImageContent.builder(
                      Base64.getEncoder().encodeToString(imageBytes(owner, artifact)),
                      artifact.mimeType())
                  .build())
          .build();
    }
    return textResult(operation);
  }

  private byte[] imageBytes(UUID owner, Contracts.Artifact artifact) {
    if (artifact.sizeBytes() > IMAGE_LIMIT) {
      throw ApiException.conflict(
          "CONTENT_INLINE_LIMIT",
          "Оригинал сохранён без обрезания, но превышает предел передачи 8 MiB.");
    }
    try (var stream = artifacts.openOwnerArtifact(owner, artifact.id())) {
      byte[] bytes = stream.readNBytes(IMAGE_LIMIT + 1);
      String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
      if (bytes.length != artifact.sizeBytes() || !hash.equals(artifact.sha256())) {
        throw ApiException.conflict(
            "CONTENT_INTEGRITY", "Контроль целостности оригинала не пройден.");
      }
      return bytes;
    } catch (IOException exception) {
      throw ApiException.conflict(
          "CONTENT_UNAVAILABLE", "Не удалось прочитать сохранённый оригинал.");
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
  }

  public record Presentation(
      Contracts.Task task,
      UUID generation,
      UUID continuationId,
      String continuationStatus,
      Long continuationRevision,
      String continuationReason,
      List<AudioAnalysisService.Summary> audio) {}

  private Presentation data(UUID owner, ChatBindings.State state) {
    return new Presentation(
        tasks.get(owner, state.taskId()),
        state.generation(),
        state.continuationId(),
        state.continuationStatus(),
        state.continuationRevision(),
        state.continuationReason(),
        audioAnalyses.summaries(owner, state.taskId()));
  }

  private McpSchema.CallToolResult presentation(Presentation state) {
    String token =
        jdbc.sql("SELECT stream_token FROM mcp_chats WHERE generation=:generation")
            .param("generation", state.generation())
            .query(String.class)
            .optional()
            .orElse("");
    return McpSchema.CallToolResult.builder()
        .structuredContent(state)
        .addTextContent(
            "Задача «"
                + state.task().title()
                + "»: "
                + state.task().status()
                + ". Каждый вызов инструмента — отдельный шаг агента, который сервер сохраняет"
                + " автоматически. Для каждого нового вызова используйте новый callId;"
                + " после потери ответа повторяйте тот же callId и аргументы. Навигация и"
                + " получение исходных данных записываются отдельными вызовами. Готовые SUCCEEDED и текст"
                + " audio.analyze используйте сразу, без повторного чтения."
                + " Итог задачи публикуйте после проверки результата.")
        .meta(
            Map.of(
                "publicUrl",
                publicUrl,
                "taskUrl",
                publicUrl + "/tasks/" + state.task().id() + "?tab=overview",
                "loginUrl",
                publicUrl + "/tasks/" + state.task().id() + "?tab=overview&login=1",
                "eventsUrl",
                publicUrl + "/widget/events?ticket=" + token))
        .build();
  }

  private McpSchema.CallToolResult textResult(Object value) {
    return McpSchema.CallToolResult.builder()
        .addTextContent(json.write(modelData(json.tree(value))))
        .build();
  }

  private Object modelData(JsonNode value) {
    if (value.isObject()) {
      boolean audio = value.path("mimeType").asString("").startsWith("audio/");
      Map<String, Object> result = new LinkedHashMap<>();
      for (var entry : value.properties()) {
        if (audio
            && Set.of("sourceUrl", "downloadUrl", "url", "blob", "base64")
                .contains(entry.getKey())) {
          continue;
        }
        result.put(entry.getKey(), modelData(entry.getValue()));
      }
      return result;
    }
    if (value.isArray()) {
      List<Object> result = new ArrayList<>(value.size());
      for (JsonNode item : value) {
        result.add(modelData(item));
      }
      return result;
    }
    return value;
  }

  public List<SyncResourceSpecification> resources() {
    var resource =
        McpSchema.Resource.builder(widgetUri, "Helm Glass task")
            .mimeType("text/html;profile=mcp-app")
            .build();
    return List.of(
        new SyncResourceSpecification(
            resource,
            (exchange, request) -> {
              long started = System.nanoTime();
              String outcome = "ERROR";
              try {
                actor(exchange.transportContext());
                Map<String, Object> csp =
                    Map.of(
                        "connectDomains",
                        List.of(publicUrl),
                        "resourceDomains",
                        List.of(publicUrl),
                        "frameDomains",
                        List.of(publicUrl));
                var contents =
                    McpSchema.TextResourceContents.builder(widgetUri, widgetHtml)
                        .mimeType("text/html;profile=mcp-app")
                        .meta(
                            Map.of(
                                "ui",
                                Map.of("prefersBorder", true, "csp", csp),
                                "openai/widgetCSP",
                                Map.of("redirect_domains", List.of(publicUrl)),
                                "openai/widgetDescription",
                                WIDGET_PRESENTATION_INSTRUCTIONS))
                        .build();
                var result = McpSchema.ReadResourceResult.builder(List.of(contents)).build();
                outcome = "OK";
                return result;
              } finally {
                log.info(
                    "MCP_RESOURCE name=task-widget durationMs={} outcome={}",
                    TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started),
                    outcome);
              }
            }));
  }

  private static Contracts.OperationVerification verification(JsonNode input) {
    if (!input.isObject()
        || input.size() != 3
        || !input.has("outcome")
        || !input.has("evidence")
        || !input.has("observationOperationId")) {
      throw ApiException.invalid(
          "verification", "Требуются результат, свидетельство и наблюдение.");
    }
    for (String field : List.of("outcome", "evidence", "observationOperationId")) {
      if (!input.path(field).isString()) {
        throw ApiException.invalid(field, "Значение должно быть строкой.");
      }
    }
    UUID observation;
    try {
      observation = uuid(input, "observationOperationId");
      if (!observation.toString().equalsIgnoreCase(string(input, "observationOperationId"))) {
        throw new IllegalArgumentException("Noncanonical UUID");
      }
    } catch (IllegalArgumentException exception) {
      throw ApiException.invalid("observationOperationId", "Укажите ID успешного наблюдения.");
    }
    return new Contracts.OperationVerification(
        string(input, "outcome"), string(input, "evidence"), observation);
  }

  private static String string(JsonNode input, String name) {
    return input.path(name).asString();
  }

  private static UUID uuid(JsonNode input, String name) {
    return UUID.fromString(string(input, name));
  }

  private static Map<String, Object> text(int maximum) {
    return Map.of("type", "string", "maxLength", maximum);
  }

  private static Map<String, Object> uuid() {
    return Map.of("type", "string", "format", "uuid");
  }

  private static Map<String, Object> key() {
    return Map.of("type", "string", "minLength", 8, "maxLength", 128);
  }

  private static Map<String, Object> bool() {
    return Map.of("type", "boolean");
  }

  private static Map<String, Object> choice(String... values) {
    return Map.of("type", "string", "enum", List.of(values));
  }

  private static Map<String, Object> array(Map<String, Object> items, int maximum) {
    return Map.of("type", "array", "items", items, "maxItems", maximum);
  }

  private static Map<String, Object> object(Map<String, Object> properties, String... required) {
    return Map.of(
        "type",
        "object",
        "properties",
        properties,
        "required",
        List.of(required),
        "additionalProperties",
        false);
  }

  private static Map<String, Object> listSchema() {
    return object(
        Map.of(
            "search",
            text(300),
            "status",
            array(text(40), 50),
            "site",
            array(text(253), 50),
            "page",
            Map.of("type", "integer", "minimum", 1),
            "pageSize",
            Map.of("type", "integer", "enum", List.of(10, 20, 50)),
            "sort",
            text(40),
            "direction",
            choice("asc", "desc")));
  }

  private static ListQuery listQuery(Map<String, Object> input) {
    var values = new LinkedMultiValueMap<String, String>();
    input.forEach(
        (key, value) -> {
          if (value instanceof List<?> items) {
            items.forEach(item -> values.add(key, String.valueOf(item)));
          } else {
            values.add(key, String.valueOf(value));
          }
        });
    return ListQuery.from(values);
  }

  private static Map<String, Object> commandSchema() {
    return object(
        Map.ofEntries(
            Map.entry(
                "type", choice("PREPARE", "AMEND", "RESUME", "STOP", "FINISH", "REQUIRE_LOGIN")),
            Map.entry("expectedVersion", Map.of("type", "integer", "minimum", 1)),
            Map.entry("title", text(200)),
            Map.entry("goal", text(20000)),
            Map.entry("startUrl", text(4096)),
            Map.entry("outputFormat", choice("TEXT", "TABLE", "REPORT")),
            Map.entry("preferredConnectionIds", array(uuid(), 50)),
            Map.entry("confirmBrowserLoss", bool()),
            Map.entry(
                "text",
                Map.of(
                    "type",
                    "string",
                    "maxLength",
                    20000,
                    "description",
                    "Для FINISH — полный итог с полученными данными и ограничениями;"
                        + " заменяет result.summary, включая ранее опубликованный."
                        + " Для REQUIRE_LOGIN — объяснение необходимости входа.")),
            Map.entry("outcome", choice("SUCCEEDED", "PARTIAL", "NOT_ACHIEVED"))),
        "type",
        "expectedVersion");
  }

  private static Map<String, Object> actionSchema() {
    return object(
        Map.of(
            "operationId",
            uuid(),
            "observeAfter",
            bool(),
            "confirmationPrompt",
            text(4000),
            "type",
            choice(
                "navigate",
                "click",
                "fill",
                "press",
                "selectOption",
                "check",
                "scroll",
                "goBack",
                "newTab",
                "selectTab",
                "closeTab",
                "observe",
                "screenshot",
                "listMedia",
                "captureAudio",
                "waitFor"),
            "instructionRevision",
            Map.of("type", "integer", "minimum", 1),
            "controlEpoch",
            Map.of("type", "integer", "minimum", 0),
            "arguments",
            object(
                Map.ofEntries(
                    Map.entry("url", text(8192)),
                    Map.entry("observationId", uuid()),
                    Map.entry("screenshotId", uuid()),
                    Map.entry("ref", text(40)),
                    Map.entry("cursor", text(100)),
                    Map.entry("text", text(20000)),
                    Map.entry("textGone", text(1000)),
                    Map.entry("time", Map.of("type", "number", "exclusiveMinimum", 0, "maximum", 30)),
                    Map.entry("key", text(100)),
                    Map.entry("values", array(text(1000), 100)),
                    Map.entry("checked", bool()),
                    Map.entry("x", Map.of("type", "number")),
                    Map.entry("y", Map.of("type", "number")),
                    Map.entry("tabId", uuid()),
                    Map.entry("sourceId", uuid()),
                    Map.entry("sourceRef", text(1000)),
                    Map.entry(
                        "sourceContext",
                        object(
                            Map.of(
                                "assignmentId",
                                text(1000),
                                "instruction",
                                text(20000),
                                "questions",
                                array(text(4000), 100)),
                            "assignmentId",
                            "instruction",
                            "questions")),
                    Map.entry("name", text(240))))),
        "operationId",
        "type",
        "instructionRevision",
        "arguments");
  }

  private static Map<String, Object> resultSchema() {
    return object(
        Map.of(
            "summary",
            text(20000),
            "limitations",
            array(text(4000), 100),
            "sources",
            array(object(Map.of("title", text(500), "url", text(4096)), "title", "url"), 100),
            "columns",
            array(
                object(
                    Map.of(
                        "key", Map.of("type", "string", "pattern", "^[A-Za-z_][A-Za-z0-9_]{0,63}$"),
                        "label", text(200),
                        "type", choice("string", "number", "boolean", "date", "url")),
                    "key",
                    "label",
                    "type"),
                100)),
        "summary");
  }
}
