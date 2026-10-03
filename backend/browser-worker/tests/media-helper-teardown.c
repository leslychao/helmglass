#define main media_helper_main
#include "../native/media-helper.c"
#undef main

#include <sys/wait.h>

typedef struct { GstElement parent; } FailingElement;
typedef struct { GstElementClass parent; } FailingElementClass;
G_DEFINE_TYPE(FailingElement, failing_element, GST_TYPE_ELEMENT)

static GstStateChangeReturn fail_stop(GstElement *element, GstStateChange transition) {
  if (transition == GST_STATE_CHANGE_READY_TO_NULL) return GST_STATE_CHANGE_FAILURE;
  return GST_ELEMENT_CLASS(failing_element_parent_class)->change_state(element, transition);
}

static void failing_element_class_init(FailingElementClass *klass) {
  GST_ELEMENT_CLASS(klass)->change_state = fail_stop;
}

static void failing_element_init(FailingElement *element) { (void)element; }

static void exercise(gboolean fail, gboolean stop_all) {
  consumers = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, destroy_consumer);
  GstElement *element = fail ? g_object_new(failing_element_get_type(), NULL) : gst_pipeline_new("confirmed-stop");
  g_assert_nonnull(element);
  g_assert_cmpint(gst_element_set_state(element, GST_STATE_READY), !=, GST_STATE_CHANGE_FAILURE);
  Consumer *consumer = g_new0(Consumer, 1);
  consumer->pipeline = element;
  consumer->expires_at = g_get_monotonic_time() + G_USEC_PER_SEC;
  g_hash_table_insert(consumers, g_strdup("fixture-peer"), consumer);
  JsonObject *request = json_object_new();
  json_object_set_string_member(request, "type", stop_all ? "stop" : "revoke");
  json_object_set_string_member(request, "requestId", "fixture-request");
  json_object_set_string_member(request, "peerId", "fixture-peer");
  handle(request);
  handle(request); /* A confirmed repeated teardown remains harmless. */
  json_object_unref(request);
  g_hash_table_destroy(consumers);
}

static void check(gboolean fail, gboolean stop_all) {
  int output[2];
  g_assert_cmpint(pipe(output), ==, 0);
  pid_t child = fork();
  g_assert_cmpint(child, >=, 0);
  if (child == 0) {
    close(output[0]);
    g_assert_cmpint(dup2(output[1], STDOUT_FILENO), >=, 0);
    close(output[1]);
    alarm(5);
    exercise(fail, stop_all);
    _exit(EXIT_SUCCESS);
  }
  close(output[1]);
  char response[2048] = {0};
  size_t length = 0;
  ssize_t received;
  while ((received = read(output[0], response + length, sizeof(response) - length - 1)) > 0) {
    length += (size_t)received;
    g_assert_cmpuint(length, <, sizeof(response) - 1);
  }
  close(output[0]);
  int status = 0;
  g_assert_cmpint(waitpid(child, &status, 0), ==, child);
  g_assert_true(WIFEXITED(status));
  g_assert_cmpint(WEXITSTATUS(status), ==, fail ? EXIT_FAILURE : EXIT_SUCCESS);
  if (fail) {
    g_assert_nonnull(strstr(response, "TEARDOWN_UNCONFIRMED"));
    g_assert_null(strstr(response, "Ack"));
  } else {
    g_assert_nonnull(strstr(response, stop_all ? "teardownAck" : "revokeAck"));
    g_assert_null(strstr(response, "error"));
  }
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  check(FALSE, FALSE);
  check(FALSE, TRUE);
  check(TRUE, FALSE);
  check(TRUE, TRUE);
  puts("Native teardown: confirmed revoke/stop and failed revoke/stop passed");
  return EXIT_SUCCESS;
}
