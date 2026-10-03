package com.helmglass.operation.domain;

import java.util.UUID;

public record MutationReceipt(UUID operationId, ResourceReference resource, String statusUrl,
    UUID requestId) {
  public record ResourceReference(String type, UUID id, long version) {}
}
