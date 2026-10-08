package ru.helmglass.api.mcp;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.TypeRef;
import java.io.IOException;
import tools.jackson.core.JacksonException;

/** Keeps request content out of the SDK's protocol-conversion error messages. */
final class McpMessageMapper implements McpJsonMapper {
  private final McpJsonMapper delegate = McpJsonDefaults.getMapper();

  @Override
  public <T> T readValue(String content, Class<T> type) throws IOException {
    return delegate.readValue(content, type);
  }

  @Override
  public <T> T readValue(byte[] content, Class<T> type) throws IOException {
    return delegate.readValue(content, type);
  }

  @Override
  public <T> T readValue(String content, TypeRef<T> type) throws IOException {
    return delegate.readValue(content, type);
  }

  @Override
  public <T> T readValue(byte[] content, TypeRef<T> type) throws IOException {
    return delegate.readValue(content, type);
  }

  @Override
  public <T> T convertValue(Object value, Class<T> type) {
    try {
      return delegate.convertValue(value, type);
    } catch (JacksonException exception) {
      throw new IllegalArgumentException("Invalid MCP message structure", exception);
    }
  }

  @Override
  public <T> T convertValue(Object value, TypeRef<T> type) {
    try {
      return delegate.convertValue(value, type);
    } catch (JacksonException exception) {
      throw new IllegalArgumentException("Invalid MCP message structure", exception);
    }
  }

  @Override
  public String writeValueAsString(Object value) throws IOException {
    return delegate.writeValueAsString(value);
  }

  @Override
  public byte[] writeValueAsBytes(Object value) throws IOException {
    return delegate.writeValueAsBytes(value);
  }
}
