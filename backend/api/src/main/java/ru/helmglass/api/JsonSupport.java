package ru.helmglass.api;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;

@Component
public class JsonSupport {
  private final ObjectMapper mapper;

  public JsonSupport(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  public String write(Object value) {
    return mapper.writeValueAsString(value);
  }

  public String canonical(Object value) {
    return mapper
        .writer()
        .with(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
        .writeValueAsString(mapper.convertValue(value, Object.class));
  }

  public JsonNode read(String value) {
    return value == null ? null : mapper.readTree(value);
  }

  public JsonNode tree(Object value) {
    return mapper.valueToTree(value);
  }

  public <T> T convert(JsonNode value, Class<T> type) {
    return mapper.treeToValue(value, type);
  }

  public List<UUID> uuidList(String value) {
    List<UUID> result = new ArrayList<>();
    JsonNode array = read(value);
    if (array != null && array.isArray()) {
      for (JsonNode item : array) {
        result.add(UUID.fromString(item.asString()));
      }
    }
    return List.copyOf(result);
  }
}
