#define _POSIX_C_SOURCE 200809L
#include <gst/gst.h>
#include <json-glib/json-glib.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* The helper owns media only. A Chromium Page never crosses this IPC boundary. */
typedef struct {
  gint64 expires_at;
  GstElement *pipeline;
  gchar **turn_servers;
} Consumer;

static GMainLoop *loop;
static GstElement *pipeline;
static GstElement *sink;
static GHashTable *consumers;
static GMutex mutex;
static gint64 last_raw_capture;
static guint64 raw_sequence;
static guint64 generation;
static const char *encoder_name;
static Display *display;
static gchar *http_proxy;
static const gint SOURCE_FPS_CEILING = 90;

static void emit(JsonBuilder *builder) {
  JsonGenerator *generator = json_generator_new();
  JsonNode *root = json_builder_get_root(builder);
  json_generator_set_root(generator, root);
  gchar *text = json_generator_to_data(generator, NULL);
  flockfile(stdout);
  fprintf(stdout, "%s\n", text);
  fflush(stdout);
  funlockfile(stdout);
  g_free(text);
  json_node_free(root);
  g_object_unref(generator);
  g_object_unref(builder);
}

static JsonBuilder *message(const char *type, const char *request_id) {
  JsonBuilder *builder = json_builder_new();
  json_builder_begin_object(builder);
  json_builder_set_member_name(builder, "type");
  json_builder_add_string_value(builder, type);
  if (request_id) {
    json_builder_set_member_name(builder, "requestId");
    json_builder_add_string_value(builder, request_id);
  }
  return builder;
}

static void error(const char *request_id, const char *code) {
  JsonBuilder *builder = message("error", request_id);
  json_builder_set_member_name(builder, "code");
  json_builder_add_string_value(builder, code);
  json_builder_end_object(builder);
  emit(builder);
}

static void stop_pipeline(GstElement *element, GstClockTime timeout) {
  GstStateChangeReturn requested = gst_element_set_state(element, GST_STATE_NULL);
  GstState state = GST_STATE_VOID_PENDING;
  GstStateChangeReturn completed = gst_element_get_state(element, &state, NULL, timeout);
  if (requested == GST_STATE_CHANGE_FAILURE || completed == GST_STATE_CHANGE_FAILURE || state != GST_STATE_NULL) {
    error(NULL, "TEARDOWN_UNCONFIRMED");
    /* Do not acknowledge an unconfirmed peer or allow a later retry to forget it. */
    _exit(EXIT_FAILURE);
  }
}

static void destroy_consumer(gpointer raw) {
  Consumer *consumer = raw;
  if (consumer->pipeline) {
    stop_pipeline(consumer->pipeline, GST_SECOND);
    gst_object_unref(consumer->pipeline);
  }
  g_strfreev(consumer->turn_servers);
  g_free(consumer);
}

static void teardown(void) {
  GstElement *old = pipeline;
  pipeline = NULL;
  sink = NULL;
  if (old) {
    stop_pipeline(old, GST_SECOND);
    gst_object_unref(old);
  }
  g_mutex_lock(&mutex);
  GHashTable *old_consumers = consumers;
  consumers = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, destroy_consumer);
  last_raw_capture = 0;
  g_mutex_unlock(&mutex);
  g_hash_table_destroy(old_consumers);
}

static gboolean smoke_encoder(const char *factory) {
  if (!gst_element_factory_find(factory)) return FALSE;
  gchar *description = g_strdup_printf(
    "videotestsrc num-buffers=4 ! video/x-raw,width=320,height=180,framerate=15/1 ! "
    "videoconvert ! %s ! h264parse ! avdec_h264 ! fakesink sync=false", factory);
  GError *failure = NULL;
  GstElement *test = gst_parse_launch(description, &failure);
  g_free(description);
  if (failure || !test) {
    g_clear_error(&failure);
    if (test) gst_object_unref(test);
    return FALSE;
  }
  GstBus *bus = gst_element_get_bus(test);
  gst_element_set_state(test, GST_STATE_PLAYING);
  GstMessage *result = gst_bus_timed_pop_filtered(bus, 8 * GST_SECOND, GST_MESSAGE_EOS | GST_MESSAGE_ERROR);
  gboolean success = result && GST_MESSAGE_TYPE(result) == GST_MESSAGE_EOS;
  if (result) gst_message_unref(result);
  gst_element_set_state(test, GST_STATE_NULL);
  gst_object_unref(bus);
  gst_object_unref(test);
  return success;
}

static void select_encoder(void) {
  if (smoke_encoder("nvh264enc")) encoder_name = "nvh264enc";
  else if (smoke_encoder("openh264enc")) encoder_name = "openh264enc";
  GList *factories = gst_element_factory_list_get_elements(GST_ELEMENT_FACTORY_TYPE_VIDEO_ENCODER, GST_RANK_NONE);
  for (GList *item = factories; item; item = item->next) {
    GstPluginFeature *feature = GST_PLUGIN_FEATURE(item->data);
    gboolean selected = encoder_name && !strcmp(gst_plugin_feature_get_name(feature), encoder_name);
    gst_plugin_feature_set_rank(feature, selected ? GST_RANK_PRIMARY + 100 : GST_RANK_NONE);
  }
  gst_plugin_feature_list_free(factories);
}

static GstPadProbeReturn raw_buffer(GstPad *pad, GstPadProbeInfo *info, gpointer data) {
  (void)pad; (void)info; (void)data;
  g_mutex_lock(&mutex);
  last_raw_capture = g_get_monotonic_time();
  raw_sequence++;
  g_mutex_unlock(&mutex);
  return GST_PAD_PROBE_OK;
}

static gboolean encoder_setup(GstElement *element, const gchar *consumer_id, const gchar *pad_name,
                              GstElement *encoder, gpointer data) {
  (void)element; (void)consumer_id; (void)pad_name; (void)data;
  if (encoder_name && !strcmp(encoder_name, "nvh264enc")) {
    g_object_set(encoder, "bframes", 0, "rc-lookahead", 0, "zerolatency", TRUE, NULL);
  }
  return FALSE;
}

static void consumer_added(GstElement *element, const gchar *peer_id, GstElement *webrtcbin, gpointer data) {
  (void)element; (void)data;
  if (http_proxy) g_object_set(webrtcbin, "http-proxy", http_proxy, "ice-transport-policy", 1, NULL);
  /* The capture source is shared; TURN authority belongs to this viewer lease. */
  g_mutex_lock(&mutex);
  Consumer *consumer = g_hash_table_lookup(consumers, peer_id);
  gchar **turn_servers = consumer ? g_strdupv(consumer->turn_servers) : NULL;
  g_mutex_unlock(&mutex);
  if (turn_servers) {
    for (guint index = 0; turn_servers[index]; index++) {
      gboolean accepted = FALSE;
      g_signal_emit_by_name(webrtcbin, "add-turn-server", turn_servers[index], &accepted);
      if (!accepted) { error(NULL, "TURN_BINDING_INVALID"); _exit(EXIT_FAILURE); }
    }
    g_strfreev(turn_servers);
  }
}

static void consumer_created(GstElement *element, const gchar *peer_id, GstElement *peer_pipeline, gpointer data) {
  (void)element; (void)data;
  g_mutex_lock(&mutex);
  Consumer *consumer = g_hash_table_lookup(consumers, peer_id);
  if (!consumer) {
    g_mutex_unlock(&mutex);
    stop_pipeline(peer_pipeline, GST_SECOND);
    return;
  }
  if (consumer->pipeline) gst_object_unref(consumer->pipeline);
  consumer->pipeline = gst_object_ref(peer_pipeline);
  g_mutex_unlock(&mutex);
}

static gboolean watch_leases(gpointer data) {
  (void)data;
  gint64 now = g_get_monotonic_time();
  GPtrArray *expired = g_ptr_array_new_with_free_func(g_free);
  g_mutex_lock(&mutex);
  GHashTableIter iterator;
  gpointer key, value;
  g_hash_table_iter_init(&iterator, consumers);
  while (g_hash_table_iter_next(&iterator, &key, &value)) {
    Consumer *consumer = value;
    if (consumer->expires_at <= now) g_ptr_array_add(expired, g_strdup(key));
  }
  g_mutex_unlock(&mutex);
  for (guint index = 0; index < expired->len; index++) {
    const char *peer = g_ptr_array_index(expired, index);
    g_mutex_lock(&mutex);
    gpointer stolen_key = NULL;
    gpointer stolen_value = NULL;
    g_hash_table_steal_extended(consumers, peer, &stolen_key, &stolen_value);
    g_mutex_unlock(&mutex);
    g_free(stolen_key);
    Consumer *consumer = stolen_value;
    if (consumer) destroy_consumer(consumer);
    JsonBuilder *builder = message("consumerStopped", NULL);
    json_builder_set_member_name(builder, "peerId"); json_builder_add_string_value(builder, peer);
    json_builder_end_object(builder); emit(builder);
  }
  g_ptr_array_free(expired, TRUE);
  g_mutex_lock(&mutex);
  gboolean empty = g_hash_table_size(consumers) == 0;
  g_mutex_unlock(&mutex);
  if (pipeline && empty) teardown();
  return G_SOURCE_CONTINUE;
}

static unsigned long window_pid(Window window) {
  Atom type;
  int format;
  unsigned long count, remaining;
  unsigned char *data = NULL;
  Atom atom = XInternAtom(display, "_NET_WM_PID", False);
  if (XGetWindowProperty(display, window, atom, 0, 1, False, XA_CARDINAL, &type, &format, &count, &remaining, &data) != Success) return 0;
  unsigned long pid = data && count == 1 && format == 32 ? *(unsigned long *)data : 0;
  if (data) XFree(data);
  return pid;
}

static void enumerate_windows(JsonBuilder *builder, Window parent, unsigned int depth) {
  if (depth > 5) return;
  Window root, returned_parent, *children = NULL;
  unsigned int count;
  if (!XQueryTree(display, parent, &root, &returned_parent, &children, &count)) return;
  for (unsigned int index = 0; index < count; index++) {
    Window window = children[index];
    XWindowAttributes attributes;
    unsigned long pid = window_pid(window);
    if (pid && XGetWindowAttributes(display, window, &attributes) && attributes.map_state == IsViewable) {
      int x, y; Window child;
      XTranslateCoordinates(display, window, DefaultRootWindow(display), 0, 0, &x, &y, &child);
      json_builder_begin_object(builder);
      json_builder_set_member_name(builder, "xid"); json_builder_add_int_value(builder, (gint64)window);
      json_builder_set_member_name(builder, "pid"); json_builder_add_int_value(builder, (gint64)pid);
      json_builder_set_member_name(builder, "x"); json_builder_add_int_value(builder, x);
      json_builder_set_member_name(builder, "y"); json_builder_add_int_value(builder, y);
      json_builder_set_member_name(builder, "width"); json_builder_add_int_value(builder, attributes.width);
      json_builder_set_member_name(builder, "height"); json_builder_add_int_value(builder, attributes.height);
      json_builder_end_object(builder);
    }
    enumerate_windows(builder, window, depth + 1);
  }
  if (children) XFree(children);
}

static gboolean create_pipeline(JsonObject *request) {
  if (!encoder_name || !display || pipeline) return FALSE;
  Window window = (Window)json_object_get_int_member(request, "xid");
  int width = (int)json_object_get_int_member(request, "width");
  int height = (int)json_object_get_int_member(request, "height");
  unsigned long expected_pid = (unsigned long)json_object_get_int_member(request, "pid");
  XWindowAttributes attributes;
  if (!XGetWindowAttributes(display, window, &attributes) || attributes.map_state != IsViewable ||
      window_pid(window) != expected_pid || attributes.width != width || attributes.height != height ||
      width < 640 || width > 1920 || height < 480 || height > 1080) return FALSE;
  GstElement *source = gst_element_factory_make("ximagesrc", "viewport-source");
  GstElement *queue = gst_element_factory_make("queue", "raw-latest");
  GstElement *convert = gst_element_factory_make("videoconvert", "convert");
  GstElement *capsfilter = gst_element_factory_make("capsfilter", "rate");
  sink = gst_element_factory_make("webrtcsink", "viewer-sink");
  if (!source || !queue || !convert || !capsfilter || !sink) {
    if (source) gst_object_unref(source);
    if (queue) gst_object_unref(queue);
    if (convert) gst_object_unref(convert);
    if (capsfilter) gst_object_unref(capsfilter);
    if (sink) gst_object_unref(sink);
    sink = NULL;
    return FALSE;
  }
  pipeline = gst_pipeline_new("helm-viewport");
  g_object_set(source, "xid", (guint64)window, "use-damage", FALSE, "show-pointer", FALSE, NULL);
  g_object_set(queue, "leaky", 2, "max-size-buffers", 1, "max-size-bytes", 0, "max-size-time", (guint64)0, NULL);
  GstCaps *raw = gst_caps_new_simple("video/x-raw", "framerate", GST_TYPE_FRACTION, SOURCE_FPS_CEILING, 1, NULL);
  g_object_set(capsfilter, "caps", raw, NULL); gst_caps_unref(raw);
  GstCaps *video = gst_caps_from_string("video/x-h264");
  g_object_set(sink, "video-caps", video, "enable-control-data-channel", FALSE,
      "enable-data-channel-navigation", FALSE, "stun-server", NULL, "ice-transport-policy", 1, NULL);
  gst_caps_unref(video);
  GstObject *signaller = NULL;
  g_object_get(sink, "signaller", &signaller, NULL);
  g_object_set(signaller, "uri", "ws://127.0.0.1:8443", NULL);
  gst_object_unref(signaller);
  g_signal_connect(sink, "encoder-setup", G_CALLBACK(encoder_setup), NULL);
  g_signal_connect(sink, "consumer-pipeline-created", G_CALLBACK(consumer_created), NULL);
  g_signal_connect(sink, "consumer-added", G_CALLBACK(consumer_added), NULL);
  gst_bin_add_many(GST_BIN(pipeline), source, capsfilter, queue, convert, sink, NULL);
  if (!gst_element_link_many(source, capsfilter, queue, convert, sink, NULL)) { teardown(); return FALSE; }
  GstPad *pad = gst_element_get_static_pad(source, "src");
  gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, raw_buffer, NULL, NULL); gst_object_unref(pad);
  if (gst_element_set_state(pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) { teardown(); return FALSE; }
  return TRUE;
}

static gchar **read_turn_servers(JsonObject *request) {
  JsonNode *node = json_object_get_member(request, "turnServers");
  if (!node || !JSON_NODE_HOLDS_ARRAY(node)) return NULL;
  JsonArray *array = json_node_get_array(node);
  guint length = json_array_get_length(array);
  if (!length || length > 4) return NULL;
  gchar **servers = g_new0(gchar *, length + 1);
  for (guint index = 0; index < length; index++) {
    JsonNode *entry = json_array_get_element(array, index);
    if (!JSON_NODE_HOLDS_VALUE(entry) || json_node_get_value_type(entry) != G_TYPE_STRING) {
      g_strfreev(servers); return NULL;
    }
    const char *url = json_node_get_string(entry);
    if (!url || !*url || strlen(url) > 8192) { g_strfreev(servers); return NULL; }
    servers[index] = g_strdup(url);
  }
  return servers;
}

static void handle(JsonObject *request) {
  const char *type = json_object_get_string_member(request, "type");
  const char *request_id = json_object_get_string_member(request, "requestId");
  if (!type || !request_id) { error(NULL, "INVALID_IPC"); return; }
  if (!strcmp(type, "capabilities")) {
    JsonBuilder *builder = message("capabilities", request_id);
    json_builder_set_member_name(builder, "encoder");
    if (encoder_name) json_builder_add_string_value(builder, encoder_name); else json_builder_add_null_value(builder);
    json_builder_set_member_name(builder, "fallbackReason");
    json_builder_add_string_value(builder, encoder_name && !strcmp(encoder_name, "nvh264enc") ? "NONE" : "NVENC_SMOKE_FAILED");
    json_builder_set_member_name(builder, "gstreamerVersion"); json_builder_add_string_value(builder, gst_version_string());
    json_builder_end_object(builder); emit(builder); return;
  }
  if (!strcmp(type, "discover")) {
    JsonBuilder *builder = message("surfaces", request_id);
    json_builder_set_member_name(builder, "windows"); json_builder_begin_array(builder);
    if (display) enumerate_windows(builder, DefaultRootWindow(display), 0);
    json_builder_end_array(builder); json_builder_end_object(builder); emit(builder); return;
  }
  if (!strcmp(type, "stop")) {
    teardown();
    JsonBuilder *builder = message("teardownAck", request_id); json_builder_end_object(builder); emit(builder); return;
  }
  if (!strcmp(type, "lease")) {
    const char *peer_id = json_object_get_string_member(request, "peerId");
    gint64 duration = json_object_get_int_member(request, "durationMs");
    guint64 expected = (guint64)json_object_get_int_member(request, "generation");
    if (!peer_id || strlen(peer_id) > 128 || duration <= 0 || duration > 4900 || expected != generation) { error(request_id, "LEASE_INVALID"); return; }
    g_mutex_lock(&mutex);
    Consumer *consumer = g_hash_table_lookup(consumers, peer_id);
    if (!consumer && g_hash_table_size(consumers) < 2) {
      gchar **turn_servers = read_turn_servers(request);
      if (!turn_servers) { g_mutex_unlock(&mutex); error(request_id, "TURN_BINDING_INVALID"); return; }
      consumer = g_new0(Consumer, 1);
      consumer->turn_servers = turn_servers;
      g_hash_table_insert(consumers, g_strdup(peer_id), consumer);
    }
    if (consumer) consumer->expires_at = g_get_monotonic_time() + duration * 1000;
    g_mutex_unlock(&mutex);
    if (!consumer) { error(request_id, "VIEWER_LIMIT"); return; }
    JsonBuilder *builder = message("leaseAck", request_id); json_builder_end_object(builder); emit(builder); return;
  }
  if (!strcmp(type, "revoke")) {
    const char *peer_id = json_object_get_string_member(request, "peerId");
    if (!peer_id || strlen(peer_id) > 128) { error(request_id, "LEASE_INVALID"); return; }
    gpointer removed_key = NULL, removed_value = NULL;
    g_mutex_lock(&mutex);
    g_hash_table_steal_extended(consumers, peer_id, &removed_key, &removed_value);
    g_mutex_unlock(&mutex);
    g_free(removed_key);
    if (removed_value) destroy_consumer(removed_value);
    JsonBuilder *builder = message("revokeAck", request_id); json_builder_end_object(builder); emit(builder); return;
  }
  if (!strcmp(type, "start")) {
    const char *peer_id = json_object_get_string_member(request, "peerId");
    gint64 duration = json_object_get_int_member(request, "durationMs");
    if (!peer_id || strlen(peer_id) > 128 || duration <= 0 || duration > 4900 || pipeline) { error(request_id, "LEASE_INVALID"); return; }
    generation = (guint64)json_object_get_int_member(request, "generation");
    g_free(http_proxy);
    http_proxy = json_object_has_member(request, "httpProxy") ? g_strdup(json_object_get_string_member(request, "httpProxy")) : NULL;
    Consumer *consumer = g_new0(Consumer, 1);
    consumer->turn_servers = read_turn_servers(request);
    if (!consumer->turn_servers) { g_free(consumer); error(request_id, "TURN_BINDING_INVALID"); return; }
    consumer->expires_at = g_get_monotonic_time() + duration * 1000;
    g_mutex_lock(&mutex);
    g_hash_table_insert(consumers, g_strdup(peer_id), consumer);
    g_mutex_unlock(&mutex);
    if (!create_pipeline(request)) { error(request_id, "SURFACE_OR_STREAM_UNAVAILABLE"); return; }
    JsonBuilder *builder = message("started", request_id); json_builder_end_object(builder); emit(builder); return;
  }
  if (!strcmp(type, "captureStatus")) {
    JsonBuilder *builder = message("captureStatus", request_id);
    g_mutex_lock(&mutex);
    json_builder_set_member_name(builder, "ageMs"); json_builder_add_int_value(builder, last_raw_capture ? (g_get_monotonic_time() - last_raw_capture) / 1000 : -1);
    json_builder_set_member_name(builder, "sequence"); json_builder_add_int_value(builder, (gint64)raw_sequence);
    g_mutex_unlock(&mutex);
    json_builder_end_object(builder); emit(builder); return;
  }
  error(request_id, "UNSUPPORTED_IPC");
}

static gboolean read_request(GIOChannel *channel, GIOCondition condition, gpointer data) {
  (void)data;
  if (condition & (G_IO_HUP | G_IO_ERR)) { teardown(); g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  gchar *line = NULL; gsize size = 0; GError *failure = NULL;
  GIOStatus status = g_io_channel_read_line(channel, &line, &size, NULL, &failure);
  if (status != G_IO_STATUS_NORMAL || size > 262144) { g_clear_error(&failure); g_free(line); return G_SOURCE_CONTINUE; }
  JsonParser *parser = json_parser_new();
  if (json_parser_load_from_data(parser, line, (gssize)size, &failure)) {
    JsonNode *root = json_parser_get_root(parser);
    if (JSON_NODE_HOLDS_OBJECT(root)) handle(json_node_get_object(root)); else error(NULL, "INVALID_IPC");
  } else { g_clear_error(&failure); error(NULL, "INVALID_IPC"); }
  g_object_unref(parser); g_free(line); return G_SOURCE_CONTINUE;
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  XInitThreads(); display = XOpenDisplay(NULL);
  consumers = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, destroy_consumer);
  select_encoder();
  loop = g_main_loop_new(NULL, FALSE);
  GIOChannel *input = g_io_channel_unix_new(STDIN_FILENO);
  g_io_add_watch(input, G_IO_IN | G_IO_HUP | G_IO_ERR, read_request, NULL);
  g_timeout_add(50, watch_leases, NULL);
  g_main_loop_run(loop);
  teardown(); g_io_channel_unref(input); g_hash_table_destroy(consumers);
  if (display) XCloseDisplay(display);
  g_free(http_proxy);
  g_main_loop_unref(loop);
  return 0;
}
