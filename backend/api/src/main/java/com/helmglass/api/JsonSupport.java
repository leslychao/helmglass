package com.helmglass.api;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import org.erdtman.jcs.JsonCanonicalizer;
import org.springframework.stereotype.Component;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

@Component
public class JsonSupport {
  private final ObjectMapper mapper;
  private final ObjectMapper canonicalMapper;

  public JsonSupport(ObjectMapper mapper) {
    this.mapper = mapper;
    this.canonicalMapper =
        JsonMapper.builder().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS).build();
  }

  public String write(Object value) {
    return mapper.writeValueAsString(value);
  }

  public JsonNode tree(Object value) {
    return mapper.valueToTree(value);
  }

  public JsonNode read(String value) {
    return mapper.readTree(value);
  }

  public <T> T read(String value, Class<T> type) {
    return mapper.readValue(value, type);
  }

  public <T> T convert(JsonNode value, Class<T> type) {
    return mapper.treeToValue(value, type);
  }

  public Map<String, Object> map(String value) {
    return mapper.readValue(value, new TypeReference<Map<String, Object>>() {});
  }

  public String digest(Object value) {
    return sha256(canonicalMapper.writeValueAsBytes(value));
  }

  public String workerDigest(JsonNode value) {
    try {
      return sha256(new JsonCanonicalizer(write(value)).getEncodedUTF8());
    } catch (IOException error) {
      throw new DomainException(422, "INVALID_JSON", "Payload is not canonical JSON");
    }
  }

  public void verifyWorkerReceipt(JsonNode receipt) {
    if (!(receipt instanceof ObjectNode object)) {
      throw new DomainException(422, "INVALID_RECEIPT", "Worker receipt must be an object");
    }
    ObjectNode payload = object.deepCopy();
    payload.remove("digest");
    if (!workerDigest(payload).equals(receipt.path("digest").asString())) {
      throw new DomainException(422, "RECEIPT_DIGEST_MISMATCH", "Worker receipt digest is invalid");
    }
  }

  public static String sha256(String value) {
    return sha256(value.getBytes(StandardCharsets.UTF_8));
  }

  public static String sha256(byte[] value) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("Required SHA-256 is unavailable", error);
    }
  }
}
