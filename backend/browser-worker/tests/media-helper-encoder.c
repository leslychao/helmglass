#define main media_helper_main
#include "../native/media-helper.c"
#undef main

static void assert_enum(GObject *object, const char *property, const char *expected) {
  GParamSpec *specification = g_object_class_find_property(G_OBJECT_GET_CLASS(object), property);
  g_assert_nonnull(specification);
  GEnumClass *values = g_type_class_ref(G_PARAM_SPEC_VALUE_TYPE(specification));
  gint actual = -1;
  g_object_get(object, property, &actual, NULL);
  GEnumValue *value = g_enum_get_value(values, actual);
  g_assert_nonnull(value);
  g_assert_cmpstr(value->value_nick, ==, expected);
  g_type_class_unref(values);
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  g_assert_cmpint(argc, ==, 2);
  g_assert_true(!strcmp(argv[1], "nvenc") || !strcmp(argv[1], "software"));
  gboolean gpu = !strcmp(argv[1], "nvenc");
  select_encoder();
  g_assert_cmpstr(encoder_name, ==, gpu ? "nvh264enc" : "openh264enc");
  g_assert_true(smoke_encoder("openh264enc"));
  if (gpu) {
    GstElement *encoder = gst_element_factory_make(encoder_name, NULL);
    g_assert_nonnull(encoder);
    configure_encoder(encoder);
    assert_enum(G_OBJECT(encoder), "preset", "p1");
    assert_enum(G_OBJECT(encoder), "tune", "ultra-low-latency");
    guint bframes = 1;
    guint lookahead = 1;
    gboolean zerolatency = FALSE;
    g_object_get(encoder, "bframes", &bframes, "rc-lookahead", &lookahead,
                 "zerolatency", &zerolatency, NULL);
    g_assert_cmpuint(bframes, ==, 0);
    g_assert_cmpuint(lookahead, ==, 0);
    g_assert_true(zerolatency);
    gst_object_unref(encoder);
  }
  puts(gpu ? "Native NVENC configured encode/decode and OpenH264 passed"
           : "Native OpenH264 encode/decode without GPU passed");
  return EXIT_SUCCESS;
}
