package ru.helmglass.api;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class Idempotency {
  private final JdbcClient jdbc;
  private final JsonSupport json;

  public Idempotency(JdbcClient jdbc, JsonSupport json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  @Transactional
  public <T> T execute(
      UUID owner, String key, String scope, Object request, Class<T> type, Supplier<T> action) {
    if (key == null || key.length() < 8 || key.length() > 128) {
      throw ApiException.invalid(
          "Idempotency-Key", "Требуется ключ операции от 8 до 128 символов.");
    }
    jdbc.sql("SELECT id FROM accounts WHERE id=:id FOR UPDATE")
        .param("id", owner)
        .query(UUID.class)
        .single();
    String hash = hash(json.canonical(request));
    var existing =
        jdbc.sql(
                """
                SELECT scope,request_hash,response::text FROM idempotency_records
                WHERE owner_id=:owner AND key=:key
                """)
            .param("owner", owner)
            .param("key", key)
            .query(
                (row, index) ->
                    new Receipt(
                        row.getString("scope"),
                        row.getString("request_hash"),
                        row.getString("response")))
            .optional();
    if (existing.isPresent()) {
      Receipt receipt = existing.get();
      if (!scope.equals(receipt.scope()) || !hash.equals(receipt.hash())) {
        throw ApiException.conflict(
            "IDEMPOTENCY_CONFLICT", "Ключ уже использован другим запросом.");
      }
      if (receipt.response() == null) {
        throw ApiException.conflict("OPERATION_PENDING", "Операция ещё не завершена.");
      }
      return json.convert(json.read(receipt.response()), type);
    }
    jdbc.sql(
            """
            INSERT INTO idempotency_records(owner_id,key,scope,request_hash)
            VALUES (:owner,:key,:scope,:hash)
            """)
        .param("owner", owner)
        .param("key", key)
        .param("scope", scope)
        .param("hash", hash)
        .update();
    T result = action.get();
    jdbc.sql(
            """
            UPDATE idempotency_records SET response=CAST(:response AS jsonb)
            WHERE owner_id=:owner AND key=:key
            """)
        .param("response", json.write(result))
        .param("owner", owner)
        .param("key", key)
        .update();
    return result;
  }

  private static String hash(String request) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(request.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
  }

  private record Receipt(String scope, String hash, String response) {}
}
