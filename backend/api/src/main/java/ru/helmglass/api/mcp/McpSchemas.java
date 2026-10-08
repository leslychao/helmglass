package ru.helmglass.api.mcp;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class McpSchemas {
  private McpSchemas() {}

  static Map<String, Object> widgetState() {
    return Map.of(
        "type",
        "object",
        "anyOf",
        List.of(
            presentation(),
            object(
                Map.of(
                    "code",
                    Map.of("type", "string", "const", "STALE_WIDGET"),
                    "message",
                    string()))));
  }

  static Map<String, Object> presentation() {
    Map<String, Object> task =
        object(
            Map.ofEntries(
                Map.entry("id", string()),
                Map.entry("version", integer()),
                Map.entry("instructionRevision", integer()),
                Map.entry("title", string()),
                Map.entry("goal", string()),
                Map.entry("startUrl", nullable(string())),
                Map.entry("site", nullable(string())),
                Map.entry("outputFormat", string()),
                Map.entry("requireConfirmation", Map.of("type", "boolean")),
                Map.entry("preferredConnectionIds", array(string())),
                Map.entry("source", string()),
                Map.entry("status", string()),
                Map.entry("outcome", nullable(string())),
                Map.entry("waitReason", nullable(string())),
                Map.entry("summary", nullable(string())),
                Map.entry("request", nullable(request())),
                Map.entry("browser", nullable(browser())),
                Map.entry("result", nullable(Map.of("type", "object"))),
                Map.entry("usage", Map.of("type", "object")),
                Map.entry("allowedCommands", array(string())),
                Map.entry("createdAt", string()),
                Map.entry("updatedAt", string())));
    return object(
        Map.of(
            "task",
            task,
            "generation",
            string(),
            "continuationId",
            nullable(string()),
            "continuationStatus",
            string(),
            "continuationRevision",
            nullable(integer()),
            "continuationReason",
            nullable(string())));
  }

  private static Map<String, Object> request() {
    return object(
        Map.of(
            "id",
            string(),
            "type",
            string(),
            "prompt",
            string(),
            "version",
            integer(),
            "options",
            Map.of(),
            "operationId",
            nullable(string())));
  }

  private static Map<String, Object> browser() {
    return object(
        Map.ofEntries(
            Map.entry("id", string()),
            Map.entry("status", string()),
            Map.entry("nodeId", nullable(string())),
            Map.entry("controlOwner", string()),
            Map.entry("controlEpoch", integer()),
            Map.entry("privateMode", Map.of("type", "boolean")),
            Map.entry("currentUrl", nullable(string())),
            Map.entry("canView", Map.of("type", "boolean")),
            Map.entry("canControl", Map.of("type", "boolean")),
            Map.entry("version", integer())));
  }

  private static Map<String, Object> object(Map<String, Object> properties) {
    return Map.of(
        "type",
        "object",
        "properties",
        properties,
        "required",
        List.copyOf(properties.keySet()),
        "additionalProperties",
        false);
  }

  private static Map<String, Object> nullable(Map<String, Object> schema) {
    Map<String, Object> result = new LinkedHashMap<>(schema);
    result.put("type", List.of(schema.get("type"), "null"));
    return result;
  }

  private static Map<String, Object> string() {
    return Map.of("type", "string");
  }

  private static Map<String, Object> integer() {
    return Map.of("type", "integer");
  }

  private static Map<String, Object> array(Map<String, Object> items) {
    return Map.of("type", "array", "items", items);
  }
}
