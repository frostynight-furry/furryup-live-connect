package local.furryup;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.protobuf.CodedOutputStream;
import cn.hutool.core.lang.Pair;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import tech.ordinaryroad.live.chat.client.bilibili.listener.IBilibiliMsgListener;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.codec.bilibili.constant.BilibiliCmdEnum;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.MessageMsg;

/** Offline binary-frame regression for V2 entry/gift dispatch and the stdout boundary. */
public final class BilibiliV2Fixture {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final String AVATAR = "https://i0.hdslb.com/entry-fixture.png";

  private static String envelope(byte[] bytes) {
    return JSON.createObjectNode().put("pb", Base64.getEncoder().encodeToString(bytes)).toString();
  }

  private static String interact(int type, long timestamp) throws Exception {
    var base = new ByteArrayOutputStream(); var baseOut = CodedOutputStream.newInstance(base);
    baseOut.writeString(2, AVATAR); baseOut.flush();
    var user = new ByteArrayOutputStream(); var userOut = CodedOutputStream.newInstance(user);
    userOut.writeByteArray(2, base.toByteArray()); userOut.flush();
    var bytes = new ByteArrayOutputStream(); var out = CodedOutputStream.newInstance(bytes);
    out.writeInt64(1, 12345); out.writeString(2, "新观众❄️🐾"); out.writeInt32(5, type);
    out.writeInt64(7, timestamp); out.writeByteArray(22, user.toByteArray());
    out.writeString(99, "future field"); out.flush();
    return envelope(bytes.toByteArray());
  }

  private static String gift() throws Exception {
    var item = new ByteArrayOutputStream(); var itemOut = CodedOutputStream.newInstance(item);
    itemOut.writeInt64(1, 1); itemOut.writeString(2, "辣条🎁"); itemOut.writeInt32(3, 2);
    itemOut.writeString(9, "v2-route-transaction"); itemOut.flush();
    var bytes = new ByteArrayOutputStream(); var out = CodedOutputStream.newInstance(bytes);
    out.writeInt64(1, 12345); out.writeString(2, "新观众❄️🐾"); out.writeString(3, AVATAR);
    out.writeByteArray(10, item.toByteArray()); out.flush();
    return envelope(bytes.toByteArray());
  }

  private static void frame(BilibiliBinaryFrameHandler handler, String cmd, String data) throws Exception {
    byte[] body = JSON.createObjectNode().put("cmd", cmd).set("data", JSON.readTree(data))
      .toString().getBytes(StandardCharsets.UTF_8);
    var frame = io.netty.buffer.Unpooled.buffer(16 + body.length);
    frame.writeInt(16 + body.length).writeShort(16).writeShort(0).writeInt(5).writeInt(1).writeBytes(body);
    MessageMsg msg;
    try { msg = (MessageMsg)tech.ordinaryroad.live.chat.client.codec.bilibili.util.BilibiliCodecUtil.decode(frame).getFirst(); }
    finally { frame.release(); }
    BilibiliCmdEnum known;
    try { known = BilibiliCmdEnum.valueOf(cmd); }
    catch (IllegalArgumentException unknown) { handler.onUnknownCmd(handler, cmd, msg); return; }
    handler.onCmdMsg(known, msg);
  }

  private static void emit() throws Exception {
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, "bilibili");
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
    System.setOut(new PrintStream(OutputStream.nullOutputStream()));
    System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    var handler = new BilibiliBinaryFrameHandler(List.of(Collector.listener(IBilibiliMsgListener.class)), 1L, Pair.of(1L, 0L));
    frame(handler, "INTERACT_WORD", "{\"uid\":12345,\"uname\":\"新观众❄️🐾\",\"msg_type\":1,\"timestamp\":1700000000}");
    String enter = interact(1, 1700000000);
    frame(handler, "INTERACT_WORD_V2", enter); frame(handler, "INTERACT_WORD_V2", enter);
    frame(handler, "INTERACT_WORD_V2", "{\"data\":" + enter + "}");
    frame(handler, "INTERACT_WORD_V2:compat", enter);
    frame(handler, "INTERACT_WORD_V2", interact(2, 1700000001));
    frame(handler, "INTERACT_WORD_V2", interact(3, 1700000001));
    for (int type : new int[]{0, 4, 5, 6, 99}) frame(handler, "INTERACT_WORD_V2", interact(type, 1700000001));
    frame(handler, "SEND_GIFT_V2:compat", gift()); frame(handler, "SEND_GIFT_V2", gift());
    frame(handler, "INTERACT_WORD_V2", "{\"pb\":\"invalid!\"}");
    frame(handler, "INTERACT_WORD_V2", "{\"pb\":\"sgEC\"}"); // Truncated nested user.
    frame(handler, "SEND_GIFT_V2:compat", "{\"pb\":\"invalid!\"}");
    frame(handler, "SEND_GIFT_V2", "{\"pb\":\"UgUJ\"}");
    frame(handler, "INTERACT_WORD_V2", interact(1, 1700000002)); // A malformed event must not stop the connection.
    for (String invalid : new String[]{"null", "{}", "{\"pb\":123}", "{\"data\":{\"pb\":[]}}"}) {
      try { BilibiliInteractV2.decodeData(JSON.readTree(invalid)); throw new AssertionError("invalid envelope"); }
      catch (java.io.IOException expected) { }
    }
    try { BilibiliInteractV2.decode("A".repeat(512 * 1024 + 1)); throw new AssertionError("size limit"); }
    catch (java.io.IOException expected) { }
    if (BilibiliInteractV2.decodeData(JSON.readTree("{\"pb\":null,\"data\":" + enter + "}")).getData().getUid() != 12345)
      throw new AssertionError("nested fallback");
    System.exit(0);
  }

  private static void verify(String encoding) throws Exception {
    String executable = File.separatorChar == '\\' ? "java.exe" : "java";
    String java = Path.of(System.getProperty("java.home"), "bin", executable).toString();
    var child = new ProcessBuilder(java, "-Djdk.net.unixdomain.tmpdir=" + java, "-Dfile.encoding=UTF-8", "-Dstdout.encoding=" + encoding,
      "-cp", System.getProperty("java.class.path"), BilibiliV2Fixture.class.getName(), "--emit").start();
    var stdout = CompletableFuture.supplyAsync(() -> {
      try { return child.getInputStream().readAllBytes(); }
      catch (java.io.IOException error) { throw new java.io.UncheckedIOException(error); }
    });
    if (!child.waitFor(20, TimeUnit.SECONDS)) { child.destroyForcibly(); throw new AssertionError("fixture timeout"); }
    if (child.exitValue() != 0) throw new AssertionError("fixture exit " + child.exitValue());
    String output = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(stdout.get(5, TimeUnit.SECONDS))).toString();
    List<JsonNode> events = new ArrayList<>(); int errors = 0, giftErrors = 0;
    for (String line : output.lines().toList()) {
      JsonNode row = JSON.readTree(line);
      if (row.path("kind").asText().equals("event")) events.add(row.path("event"));
      if (row.path("state").asText().equals("message-error")) errors++;
      if (row.path("metric").asText().equals("giftParseErrors")) giftErrors++;
    }
    if (events.size() != 10 || errors != 4 || giftErrors != 2) throw new AssertionError("callback coverage");
    if (events.stream().map(e -> e.path("source_msg_id").asText()).distinct().count() != 5)
      throw new AssertionError("replayed and V1/V2 overlapping interactions must retain identity");
    if (events.stream().filter(e -> e.path("event_type").asText().equals("enter")).count() != 6
        || events.stream().filter(e -> e.path("event_type").asText().equals("follow")).count() != 1
        || events.stream().filter(e -> e.path("event_type").asText().equals("share")).count() != 1)
      throw new AssertionError("interaction classification");
    for (int i = 0; i < events.size(); i++) {
      JsonNode event = events.get(i);
      if (!event.path("user_name").asText().equals("新观众❄️🐾") || !event.path("user_id").asText().equals("12345"))
        throw new AssertionError("viewer identity and Unicode");
      if (i > 0 && !event.path("avatar_url").asText().equals(AVATAR)) throw new AssertionError("V2 avatar");
      if (event.path("event_type").asText().equals("gift")
          && (event.path("gift_count").asInt() != 2 || !event.path("gift_name").asText().equals("辣条🎁")))
        throw new AssertionError("gift routing");
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length > 0 && args[0].equals("--emit")) { emit(); return; }
    verify("GBK"); verify("UTF-8");
    System.out.println("PASS: Bilibili V1/V2 entry, follow, share, avatar, other/unknown gift routes, replay IDs, malformed isolation and UTF-8 stdout.");
  }
}
