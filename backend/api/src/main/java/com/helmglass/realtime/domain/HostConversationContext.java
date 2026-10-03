package com.helmglass.realtime.domain;

/** Bounded host correlation delegated by the authenticated MCP adapter, never by tool arguments. */
public record HostConversationContext(
    String provider, String contractVersion, String conversationKey) {

  /** Only the host contract verified by the actual model, app, and remount probes is accepted. */
  public boolean supported() {
    return "CHATGPT_WEB".equals(provider)
        && "2026-10-03".equals(contractVersion)
        && conversationKey != null
        && conversationKey.matches("[a-f0-9]{64}");
  }

  public String storageKey() {
    if (!supported()) {
      throw new IllegalStateException("Host correlation is not supported");
    }
    return provider + ":" + contractVersion + ":" + conversationKey;
  }
}
