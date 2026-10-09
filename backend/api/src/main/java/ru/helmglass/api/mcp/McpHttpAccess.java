package ru.helmglass.api.mcp;

import io.modelcontextprotocol.server.transport.HttpServletStreamableServerTransportProvider;
import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import ru.helmglass.api.ApiException;
import ru.helmglass.api.JsonSupport;
import ru.helmglass.api.auth.Actor;
import ru.helmglass.api.auth.Identity;
import tools.jackson.databind.JsonNode;

/** Binds SDK transport sessions to OAuth grants and bounds complete media responses. */
final class McpHttpAccess implements Filter {
  private static final Logger log = LoggerFactory.getLogger(McpHttpAccess.class);
  private static final String SESSION_HEADER = "Mcp-Session-Id";
  private static final int REQUEST_LIMIT = 1024 * 1024;
  private static final int SESSION_LIMIT = 256;
  private static final int OWNER_SESSION_LIMIT = 16;
  private static final long IDLE_TIMEOUT = Duration.ofMinutes(30).toNanos();
  private final Identity identity;
  private final JsonSupport json;
  private final HttpServletStreamableServerTransportProvider transport;
  private final Semaphore responseSlots = new Semaphore(2, true);
  private final Map<String, SessionBinding> sessions = new HashMap<>();
  private final Map<UUID, Integer> ownerSessions = new HashMap<>();
  private int reservedSessions;

  McpHttpAccess(Identity identity, JsonSupport json,
      HttpServletStreamableServerTransportProvider transport) {
    this.identity = identity;
    this.json = json;
    this.transport = transport;
  }

  @Override
  public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
      throws IOException, ServletException {
    HttpServletRequest httpRequest = (HttpServletRequest) request;
    HttpServletResponse httpResponse = (HttpServletResponse) response;
    SessionOwner owner;
    try {
      if (!(httpRequest.getUserPrincipal() instanceof JwtAuthenticationToken authentication)) {
        httpResponse.sendError(403, "MCP authorization required");
        return;
      }
      Actor actor = identity.authenticate(authentication.getToken());
      if (!"MCP".equals(actor.channel()) || actor.sessionId() == null) {
        httpResponse.sendError(403, "MCP authorization required");
        return;
      }
      owner = new SessionOwner(actor.id(), actor.sessionId(),
          authentication.getToken().getClaimAsString("azp"));
    } catch (ApiException exception) {
      httpResponse.sendError(exception.status().value(), exception.code());
      return;
    }

    String session = httpRequest.getHeader(SESSION_HEADER);
    if (session != null && !owns(session, owner)) {
      httpResponse.sendError(404, "MCP session unavailable");
      return;
    }
    boolean initialize = false;
    boolean boundedResponse = false;
    if ("POST".equals(httpRequest.getMethod())) {
      byte[] body = httpRequest.getInputStream().readNBytes(REQUEST_LIMIT + 1);
      if (body.length > REQUEST_LIMIT) {
        httpResponse.sendError(413, "MCP request too large");
        return;
      }
      JsonNode message;
      try {
        message = json.read(new String(body, StandardCharsets.UTF_8));
      } catch (RuntimeException exception) {
        httpResponse.sendError(400, "Invalid MCP message");
        return;
      }
      if (message == null || !message.isObject()) {
        httpResponse.sendError(400, "Invalid MCP message");
        return;
      }
      initialize = "initialize".equals(message.path("method").asString());
      String tool = message.path("params").path("name").asString();
      // Only these tools can serialize bounded, multi-megabyte media responses.
      boundedResponse = "tools/call".equals(message.path("method").asString())
          && ("operations.get".equals(tool)
              || "browser.execute".equals(tool)
                  && (message.path("params").path("arguments").has("actions")
                      || "screenshot".equals(message.path("params").path("arguments")
                          .path("action").path("type").asString())));
      httpRequest = new ReplayableRequest(httpRequest, body);
    }
    if (initialize) {
      expireIdleSessions(httpRequest, httpResponse);
    }
    if (initialize && (session != null || !reserveWithReclamation(owner, httpRequest, httpResponse))) {
      logCapacity(session == null ? "SESSION_CAPACITY" : "INITIALIZE_HAS_SESSION", owner);
      httpResponse.setHeader("Retry-After", "2");
      httpResponse.sendError(429, "MCP session capacity reached");
      return;
    }
    boolean acquired = !boundedResponse || responseSlots.tryAcquire();
    if (!acquired) {
      logCapacity("MEDIA_RESPONSE_CAPACITY", owner);
      httpResponse.setHeader("Retry-After", "2");
      httpResponse.sendError(429, "MCP response capacity reached");
      return;
    }
    SessionBinding binding = session == null ? null : beginRequest(session, owner);
    if (session != null && binding == null) {
      if (boundedResponse) {
        responseSlots.release();
      }
      httpResponse.sendError(404, "MCP session unavailable");
      return;
    }
    RequestLifetime lifetime = new RequestLifetime(session, boundedResponse);
    ReplayableRequest replayable = httpRequest instanceof ReplayableRequest parsed
        ? parsed : new ReplayableRequest(httpRequest, null);
    replayable.lifetime = lifetime;
    SessionResponse tracked = initialize ? new SessionResponse(httpResponse, owner) : null;
    try {
      if (binding != null && ("GET".equals(httpRequest.getMethod())
          || "DELETE".equals(httpRequest.getMethod()))) {
        // SDK 2.0.1 replaces its listener reference without closing the old GET.
        // Serialize only stream registration/teardown, never executing POST requests.
        if (!binding.streamRegistration.tryLock()) {
          logCapacity("STREAM_REGISTRATION_BUSY", owner);
          httpResponse.setHeader("Retry-After", "2");
          httpResponse.sendError(429, "MCP stream registration in progress");
          return;
        }
        try {
          chain.doFilter(replayable, httpResponse);
          if ("GET".equals(httpRequest.getMethod()) && httpResponse.getStatus() == 200) {
            replaceListener(session, binding, lifetime);
          } else if ("DELETE".equals(httpRequest.getMethod()) && httpResponse.getStatus() == 200) {
            remove(session);
          }
        } finally {
          binding.streamRegistration.unlock();
        }
      } else {
        chain.doFilter(replayable, tracked == null ? httpResponse : tracked);
      }
    } finally {
      // A background GET listener is not an executing operation. Disconnected, silent
      // SSE sockets are otherwise undetectable and would pin this account's quota forever.
      // Keep the registration itself protected until the SDK has installed its stream.
      if (!lifetime.async || "GET".equals(httpRequest.getMethod())) {
        lifetime.release();
      }
      if (tracked != null) {
        if (tracked.registeredSession == null) {
          release(owner);
        } else {
          finishRequest(tracked.registeredSession);
        }
      }
    }
  }

  private void replaceListener(String id, SessionBinding binding, RequestLifetime listener) {
    RequestLifetime previous;
    synchronized (this) {
      if (sessions.get(id) != binding || listener.context == null) {
        previous = listener;
      } else {
        previous = binding.listener;
        binding.listener = listener.completed ? null : listener;
      }
    }
    if (previous != null) {
      previous.complete();
    }
  }

  private synchronized void logCapacity(String reason, SessionOwner owner) {
    int active = sessions.values().stream()
        .filter(binding -> owner.account().equals(binding.owner.account()))
        .mapToInt(binding -> binding.activeRequests).sum();
    log.warn("MCP capacity rejected: reason={}, registeredSessions={}, ownerSessions={}, "
            + "activeRequests={}, mediaSlotsAvailable={}",
        reason, reservedSessions, ownerSessions.getOrDefault(owner.account(), 0),
        active, responseSlots.availablePermits());
  }

  private synchronized boolean owns(String id, SessionOwner owner) {
    SessionBinding binding = sessions.get(id);
    return binding != null && !binding.expiring && owner.equals(binding.owner);
  }

  private synchronized SessionBinding beginRequest(String id, SessionOwner owner) {
    if (!owns(id, owner)) {
      return null;
    }
    SessionBinding binding = sessions.get(id);
    binding.activeRequests++;
    return binding;
  }

  private synchronized void finishRequest(String id) {
    SessionBinding binding = sessions.get(id);
    if (binding != null) {
      binding.activeRequests--;
      binding.lastUsed = System.nanoTime();
    }
  }

  private void expireIdleSessions(HttpServletRequest request, HttpServletResponse response)
      throws ServletException, IOException {
    List<String> candidates;
    synchronized (this) {
      long now = System.nanoTime();
      candidates = sessions.entrySet().stream()
          .filter(entry -> entry.getValue().idle(now)).map(Map.Entry::getKey).toList();
    }
    for (String id : candidates) {
      synchronized (this) {
        SessionBinding binding = sessions.get(id);
        if (binding == null || !binding.idle(System.nanoTime())) {
          continue;
        }
        binding.expiring = true;
      }
      deleteSession(id, request, response);
    }
  }

  private boolean reserveWithReclamation(SessionOwner owner, HttpServletRequest request,
      HttpServletResponse response) throws ServletException, IOException {
    if (reserve(owner)) {
      return true;
    }
    String oldest;
    synchronized (this) {
      // Some hosts initialize per call and never DELETE. Reclaim only this account's
      // least recently used transport; executing requests, including POST elicitation,
      // survive. SDK DELETE also closes that transport's background GET listener.
      oldest = sessions.entrySet().stream()
          .filter(entry -> owner.account().equals(entry.getValue().owner.account())
              && !entry.getValue().expiring && entry.getValue().activeRequests == 0)
          .min(Comparator.comparingLong(entry -> entry.getValue().lastUsed))
          .map(Map.Entry::getKey).orElse(null);
      if (oldest == null) {
        return false;
      }
      sessions.get(oldest).expiring = true;
    }
    deleteSession(oldest, request, response);
    return reserve(owner);
  }

  private void deleteSession(String id, HttpServletRequest request, HttpServletResponse response)
      throws ServletException, IOException {
    SessionBinding binding;
    synchronized (this) {
      binding = sessions.get(id);
    }
    if (binding == null) {
      return;
    }
    var discarded = new DiscardedResponse(response);
    var deletion = new HttpServletRequestWrapper(request) {
      @Override
      public String getMethod() {
        return "DELETE";
      }

      @Override
      public String getHeader(String name) {
        return SESSION_HEADER.equalsIgnoreCase(name) ? id : super.getHeader(name);
      }
    };
    try {
      // Use the SDK's own teardown to remove streams and its session map together.
      if (!binding.streamRegistration.tryLock()) {
        return;
      }
      try {
        transport.service((ServletRequest) deletion, discarded);
        if (discarded.getStatus() == 200 || discarded.getStatus() == 404) {
          remove(id);
        }
      } finally {
        binding.streamRegistration.unlock();
      }
    } finally {
      synchronized (this) {
        SessionBinding remaining = sessions.get(id);
        if (remaining != null) {
          remaining.expiring = false;
        }
      }
    }
  }

  private synchronized boolean reserve(SessionOwner owner) {
    int count = ownerSessions.getOrDefault(owner.account(), 0);
    if (reservedSessions >= SESSION_LIMIT || count >= OWNER_SESSION_LIMIT) {
      return false;
    }
    reservedSessions++;
    ownerSessions.put(owner.account(), count + 1);
    return true;
  }

  private synchronized void release(SessionOwner owner) {
    reservedSessions--;
    int count = ownerSessions.getOrDefault(owner.account(), 1) - 1;
    if (count == 0) {
      ownerSessions.remove(owner.account());
    } else {
      ownerSessions.put(owner.account(), count);
    }
  }

  private synchronized void register(String id, SessionOwner owner) {
    sessions.put(id, new SessionBinding(owner));
  }

  private void remove(String id) {
    RequestLifetime listener;
    synchronized (this) {
      SessionBinding binding = sessions.remove(id);
      if (binding == null) {
        return;
      }
      release(binding.owner);
      listener = binding.listener;
      binding.listener = null;
    }
    if (listener != null) {
      listener.complete();
    }
  }

  private record SessionOwner(UUID account, String grant, String client) {}

  private static final class SessionBinding {
    private final SessionOwner owner;
    private final ReentrantLock streamRegistration = new ReentrantLock();
    private RequestLifetime listener;
    private long lastUsed = System.nanoTime();
    private int activeRequests = 1;
    private boolean expiring;

    SessionBinding(SessionOwner owner) {
      this.owner = owner;
    }

    boolean idle(long now) {
      return !expiring && activeRequests == 0 && now - lastUsed >= IDLE_TIMEOUT;
    }
  }

  private final class RequestLifetime implements AsyncListener {
    private final String session;
    private final boolean boundedResponse;
    private final AtomicBoolean released = new AtomicBoolean();
    private volatile boolean async;
    private volatile AsyncContext context;
    private boolean completed;

    RequestLifetime(String session, boolean boundedResponse) {
      this.session = session;
      this.boundedResponse = boundedResponse;
    }

    void release() {
      if (released.compareAndSet(false, true)) {
        if (boundedResponse) {
          responseSlots.release();
        }
        if (session != null) {
          finishRequest(session);
        }
      }
    }

    void complete() {
      AsyncContext current = context;
      if (current == null) {
        return;
      }
      try {
        current.complete();
      } catch (IllegalStateException exception) {
        // The container or SDK can complete the same stream concurrently.
        finish();
      }
    }

    private void finish() {
      synchronized (McpHttpAccess.this) {
        completed = true;
        SessionBinding binding = sessions.get(session);
        if (binding != null && binding.listener == this) {
          binding.listener = null;
        }
      }
      release();
    }

    @Override
    public void onComplete(AsyncEvent event) {
      finish();
    }

    @Override
    public void onTimeout(AsyncEvent event) {
      finish();
    }

    @Override
    public void onError(AsyncEvent event) {
      finish();
    }

    @Override
    public void onStartAsync(AsyncEvent event) {
      event.getAsyncContext().addListener(this);
    }
  }

  private static final class DiscardedResponse extends HttpServletResponseWrapper {
    private int status = 200;
    private final PrintWriter writer = new PrintWriter(Writer.nullWriter());

    DiscardedResponse(HttpServletResponse response) {
      super(response);
    }

    @Override
    public void setStatus(int status) {
      this.status = status;
    }

    @Override
    public int getStatus() {
      return status;
    }

    @Override
    public void sendError(int status) {
      this.status = status;
    }

    @Override
    public void sendError(int status, String message) {
      this.status = status;
    }

    @Override
    public void setHeader(String name, String value) {}

    @Override
    public void setContentType(String type) {}

    @Override
    public void setCharacterEncoding(String encoding) {}

    @Override
    public PrintWriter getWriter() {
      return writer;
    }
  }

  private final class SessionResponse extends HttpServletResponseWrapper {
    private final SessionOwner owner;
    private String registeredSession;

    SessionResponse(HttpServletResponse response, SessionOwner owner) {
      super(response);
      this.owner = owner;
    }

    @Override
    public void setHeader(String name, String value) {
      if (SESSION_HEADER.equalsIgnoreCase(name) && registeredSession == null) {
        register(Objects.requireNonNull(value), owner);
        registeredSession = value;
      }
      super.setHeader(name, value);
    }
  }

  private static final class ReplayableRequest extends HttpServletRequestWrapper {
    private final byte[] body;
    private RequestLifetime lifetime;

    ReplayableRequest(HttpServletRequest request, byte[] body) {
      super(request);
      this.body = body;
    }

    @Override
    public AsyncContext startAsync() {
      return track(super.startAsync());
    }

    @Override
    public AsyncContext startAsync(ServletRequest request, ServletResponse response) {
      return track(super.startAsync(request, response));
    }

    private AsyncContext track(AsyncContext context) {
      if (lifetime != null) {
        lifetime.context = context;
        context.addListener(lifetime);
        lifetime.async = true;
      }
      return context;
    }

    @Override
    public ServletInputStream getInputStream() throws IOException {
      if (body == null) {
        return super.getInputStream();
      }
      ByteArrayInputStream input = new ByteArrayInputStream(body);
      return new ServletInputStream() {
        @Override
        public int read() {
          return input.read();
        }

        @Override
        public int read(byte[] target, int offset, int length) {
          return input.read(target, offset, length);
        }

        @Override
        public boolean isFinished() {
          return input.available() == 0;
        }

        @Override
        public boolean isReady() {
          return true;
        }

        @Override
        public void setReadListener(ReadListener listener) {
          throw new IllegalStateException("MCP reads its bounded request synchronously");
        }
      };
    }
  }
}
