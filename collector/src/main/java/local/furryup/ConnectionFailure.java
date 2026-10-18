package local.furryup;

/** Only stable codes leave the collector; upstream messages can contain credentials. */
final class ConnectionFailure extends RuntimeException {
  final String code;
  ConnectionFailure(String code) { super(code); this.code = code; }
  static String classify(Throwable failure) {
    StringBuilder description = new StringBuilder();
    Throwable current = failure;
    for (int i = 0; current != null && i < 12; i++, current = current.getCause()) {
      if (current instanceof ConnectionFailure known) return known.code;
      description.append(current.getClass().getName()).append(' ').append(current.getMessage()).append('\n');
    }
    String text = description.toString().toLowerCase(java.util.Locale.ROOT);
    if (text.contains("unable to establish loopback connection") || text.contains("failed to create a child event loop")) return "LOCAL_NETWORK_INIT";
    // The SDK adds a speculative captcha hint to every API error. Do not treat that hint as confirmation.
    if (text.contains("请求过快") || text.contains("too many requests") || text.contains("status: 429")) return "RATE_LIMITED";
    if (text.contains("需要进行验证") || text.contains("\"result\":400002")) return "VERIFICATION_REQUIRED";
    if (text.contains("需要登录") || text.contains("未登录") || text.contains("登录失效") || text.contains("unauthorized")) return "LOGIN_REQUIRED";
    if (text.contains("sockettimeoutexception") || text.contains("connecttimeoutexception") || text.contains("timed out")) return "NETWORK_TIMEOUT";
    if (text.contains("unknownhostexception") || text.contains("connectexception")) return "NETWORK_UNREACHABLE";
    if (text.contains("sslhandshakeexception") || text.contains("certificateexception")) return "TLS_ERROR";
    if (text.contains("主播未开播") || text.contains("websocket地址为空")) return "NO_LIVE_SESSION";
    if (text.contains("nullpointerexception") || text.contains("jsonparseexception") || text.contains("jsonmappingexception") || text.contains("illegalargumentexception")) return "PROTOCOL_CHANGED";
    return "CONNECT_FAILED";
  }
  static void selfTest() {
    if (!classify(new RuntimeException("可能已触发滑块验证 请求过快 cookie=private-fixture")).equals("RATE_LIMITED")) throw new AssertionError("Rate limit classification");
    if (!classify(new RuntimeException("可能已触发滑块验证 token=private-fixture")).equals("CONNECT_FAILED")) throw new AssertionError("Speculative hint classification");
    if (!classify(new RuntimeException("需要进行验证")).equals("VERIFICATION_REQUIRED")) throw new AssertionError("Verification classification");
    if (!classify(new java.net.SocketTimeoutException("private-fixture")).equals("NETWORK_TIMEOUT")) throw new AssertionError("Timeout classification");
    if (!classify(new NullPointerException("private-fixture")).equals("PROTOCOL_CHANGED")) throw new AssertionError("Protocol classification");
    if (!classify(new ConnectionFailure("NO_LIVE_SESSION")).equals("NO_LIVE_SESSION")) throw new AssertionError("Known classification");
  }
}
