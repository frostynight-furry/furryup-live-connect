package local.furryup;

import cn.hutool.core.lang.Pair;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import tech.ordinaryroad.live.chat.client.bilibili.listener.IBilibiliMsgListener;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliCodecHandler;
import tech.ordinaryroad.live.chat.client.commons.base.msg.ICmdMsg;

/** Binary web frames through the SDK codec/dispatch and the production Collector listener. */
public final class BilibiliMainInteractionsFixture {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  private static void frame(EmbeddedChannel channel, String cmd, String data) throws Exception {
    byte[] body = JSON.createObjectNode().put("cmd", cmd).set("data", JSON.readTree(data))
      .toString().getBytes(StandardCharsets.UTF_8);
    var bytes = Unpooled.buffer(16 + body.length);
    bytes.writeInt(16 + body.length).writeShort(16).writeShort(0).writeInt(5).writeInt(1).writeBytes(body);
    channel.writeInbound(new BinaryWebSocketFrame(bytes));
  }
  private static String guard(int level, int count, long started) {
    return "{\"uid\":12345,\"username\":\"小雪❄️🐾\",\"guard_level\":" + level + ",\"num\":" + count
      + ",\"price\":138000,\"gift_id\":10003,\"start_time\":" + started + "}";
  }
  private static String toast(int source) {
    return "{\"sender_uinfo\":{\"uid\":12345,\"base\":{\"name\":\"小雪❄️🐾\",\"face\":\"https://i0.hdslb.com/snow.png\"}},"
      + "\"guard_info\":{\"guard_level\":3,\"start_time\":1700000000},"
      + "\"pay_info\":{\"num\":2,\"price\":138000,\"unit\":\"月\"},"
      + "\"gift_info\":{\"gift_id\":10003},\"option\":{\"source\":" + source + "}}";
  }
  private static String superChat(String id) {
    return "{\"id\":" + id + ",\"uid\":12345,\"message\":\"醒目留言❄️🐾\",\"price\":30,\"time\":60,"
      + "\"user_info\":{\"uname\":\"小雪❄️🐾\",\"face\":\"https://i0.hdslb.com/snow.png\"}}";
  }
  public static void main(String[] args) throws Exception {
    PrintStream errors = System.err;
    try { run(args); }
    catch (Throwable error) { error.printStackTrace(errors); System.exit(1); }
  }
  private static void run(String[] args) throws Exception {
    boolean emit = args.length > 0 && args[0].equals("--emit");
    Class.forName(Collector.class.getName()); // Capture the real UTF-8 stdout boundary first.
    System.setOut(new PrintStream(OutputStream.nullOutputStream()));
    System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, "bilibili");
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
    Map<String, String> routes = new HashMap<>();
    IBilibiliMsgListener trace = (IBilibiliMsgListener) Proxy.newProxyInstance(
      IBilibiliMsgListener.class.getClassLoader(), new Class<?>[]{IBilibiliMsgListener.class}, (proxy, method, values) -> {
        // The SDK constructs a typed SC object without copying its raw cmd string.
        if (method.getName().equals("onSuperChatMsg")) routes.put("SUPER_CHAT_MESSAGE", method.getName());
        else if (values != null && values.length > 0 && values[values.length - 1] instanceof ICmdMsg<?> message
            && List.of("onOtherCmdMsg", "onUnknownCmd", "onEntryEffect", "onSuperChatMsg").contains(method.getName()))
          routes.put(message.getCmd(), method.getName());
        return null;
      });
    var listeners = emit ? List.of(trace, Collector.listener(IBilibiliMsgListener.class)) : List.of(trace);
    var channel = new EmbeddedChannel(new BilibiliCodecHandler(), new BilibiliBinaryFrameHandler(listeners, 1L, Pair.of(1L, 0L)));
    try {
      frame(channel, "GUARD_BUY", guard(3, 2, 1700000000));
      frame(channel, "USER_TOAST_MSG", guard(3, 2, 1700000000));
      frame(channel, "USER_TOAST_MSG_V2", toast(0));
      frame(channel, "USER_TOAST_MSG_V2", toast(2));
      frame(channel, "GUARD_BUY", guard(3, 2, 1700000000));
      frame(channel, "GUARD_BUY", guard(3, 1, 1700000001));
      frame(channel, "GUARD_BUY", guard(2, 3, 1700000002));
      frame(channel, "GUARD_BUY", guard(1, 1, 1700000003));
      String entry = "{\"id\":135,\"uid\":12345,\"face\":\"https://i0.hdslb.com/snow.png\","
        + "\"copy_writing\":\"<%小雪❄️🐾%> 来了\",\"trigger_time\":1746031259272981482}";
      frame(channel, "ENTRY_EFFECT", entry);
      frame(channel, "ENTRY_EFFECT_MUST_RECEIVE", entry);
      frame(channel, "SUPER_CHAT_MESSAGE", superChat("80"));
      frame(channel, "SUPER_CHAT_MESSAGE", superChat("9007199254740993"));
      frame(channel, "SUPER_CHAT_MESSAGE", superChat("81"));
      frame(channel, "SUPER_CHAT_MESSAGE_DELETE", "{\"ids\":[80,\"9007199254740993\"]}");
      frame(channel, "SUPER_CHAT_MESSAGE_DELETE", "{\"ids\":[80,\"9007199254740993\"]}");
      // The next four events are malformed; production listener must isolate all of them.
      frame(channel, "GUARD_BUY", guard(3, 0, 1700000004));
      frame(channel, "USER_TOAST_MSG_V2", "{}");
      frame(channel, "ENTRY_EFFECT_MUST_RECEIVE", "{}");
      frame(channel, "SUPER_CHAT_MESSAGE_DELETE", "{\"ids\":{}}");
      frame(channel, "GUARD_BUY", guard(3, 1, 1700000005));
      frame(channel, "WELCOME", "{\"uid\":12345}");
      require(routes.get("GUARD_BUY").equals("onOtherCmdMsg"), "SDK guard callback must remain covered: " + routes);
      require(routes.get("USER_TOAST_MSG").equals("onOtherCmdMsg"), "SDK legacy toast callback must remain covered");
      require(routes.get("USER_TOAST_MSG_V2").equals("onUnknownCmd"), "SDK V2 toast unknown callback must remain covered");
      require(routes.get("ENTRY_EFFECT").equals("onEntryEffect"), "SDK specific entry callback must remain covered");
      require(List.of("onOtherCmdMsg", "onUnknownCmd").contains(routes.get("ENTRY_EFFECT_MUST_RECEIVE")), "SDK must-receive entry callback must remain covered");
      require(routes.get("SUPER_CHAT_MESSAGE").equals("onSuperChatMsg"), "SDK SC callback must remain covered");
      require(List.of("onOtherCmdMsg", "onUnknownCmd").contains(routes.get("SUPER_CHAT_MESSAGE_DELETE")), "SDK SC deletion callback must remain covered");
    } finally { channel.finishAndReleaseAll(); }
    if (!emit) new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8)
      .println("PASS: Bilibili SDK binary codec and guard/toast/entry/SC/deletion callback routes.");
    System.exit(0);
  }
}
