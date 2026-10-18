package local.furryup;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.protobuf.ByteString;
import com.google.protobuf.CodedOutputStream;
import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame;
import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPOutputStream;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.DouyinCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.Common;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.HeadersList;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.Message;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.PushFrame;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.Response;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.PayloadTypeOuterClass.PayloadType;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCLiveMultiPkStatisticOuterClass.SCLiveMultiPkStatistic;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCWebPipEndedOuterClass.SCWebPipEnded;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SocketMessageOuterClass.SocketMessage;
import tech.ordinaryroad.live.chat.client.douyin.listener.IDouyinMsgListener;
import tech.ordinaryroad.live.chat.client.douyin.netty.handler.DouyinBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.douyin.netty.handler.DouyinCodecHandler;
import tech.ordinaryroad.live.chat.client.kuaishou.listener.IKuaishouMsgListener;
import tech.ordinaryroad.live.chat.client.kuaishou.netty.handler.KuaishouBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.kuaishou.netty.handler.KuaishouCodecHandler;

/** Deterministic, offline socket fixtures. Never joins a live room. */
public final class PkEventsFixture {
  private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
  private interface Write { void run(CodedOutputStream out) throws IOException; }
  private static ByteString bytes(Write write) throws IOException {
    var buffer = new ByteArrayOutputStream(); var out = CodedOutputStream.newInstance(buffer);
    write.run(out); out.flush(); return ByteString.copyFrom(buffer.toByteArray());
  }
  private static ByteString battle(long now, boolean refresh) throws IOException {
    var common = Common.newBuilder().setMsgId(123456789L).setRoomId(999L).setCreateTime(now).build();
    var settings = bytes(out -> { out.writeUInt64(2, Long.parseUnsignedLong("18446744073709551614")); out.writeUInt64(3, now - 10_000); out.writeUInt64(4, 300); });
    return bytes(out -> { out.writeBytes(1, common.toByteString()); out.writeBytes(2, refresh ? ByteString.copyFrom(new byte[]{8, 1}) : settings); });
  }
  private static DouyinCmdMsg dy(String method, ByteString payload) { return new DouyinCmdMsg(Message.newBuilder().setMethod(method).setPayload(payload).build()); }
  private static KuaishouCmdMsg ks(PayloadType type, ByteString payload) { return new KuaishouCmdMsg(SocketMessage.newBuilder().setPayloadType(type).setPayload(payload).build()); }
  private static void fails(Object cmd) throws Exception {
    try { PkEvents.decode(cmd); throw new AssertionError("Malformed PK must fail"); } catch (IOException expected) { }
  }
  private static byte[] compressed(byte[] payload, boolean gzip) throws IOException {
    if (!gzip) return payload;
    var buffer = new ByteArrayOutputStream(); try (var out = new GZIPOutputStream(buffer)) { out.write(payload); }
    return buffer.toByteArray();
  }
  private static void pipeline(Object command, boolean gzip) throws Exception {
    var events = new ArrayList<ObjectNode>();
    boolean isDy = command instanceof DouyinCmdMsg;
    Class<?> type = isDy ? IDouyinMsgListener.class : IKuaishouMsgListener.class;
    Object listener = Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (proxy, method, args) -> {
      if (method.getName().equals("onMsg")) { ObjectNode event = PkEvents.decode(args[args.length - 1]); if (event != null) events.add(event); }
      return null;
    });
    EmbeddedChannel channel;
    byte[] wire;
    if (isDy) {
      var cmd = (DouyinCmdMsg) command;
      var response = Response.newBuilder().addMessagesList(cmd.getMsg()).build();
      wire = PushFrame.newBuilder().setPayloadType("msg")
        .addHeadersList(HeadersList.newBuilder().setKey("compress_type").setValue(gzip ? "gzip" : "none"))
        .setPayload(ByteString.copyFrom(compressed(response.toByteArray(), gzip))).build().toByteArray();
      channel = new EmbeddedChannel(new DouyinCodecHandler(), new DouyinBinaryFrameHandler(List.of((IDouyinMsgListener) listener), 1L));
    } else {
      var cmd = (KuaishouCmdMsg) command;
      wire = cmd.getMsg().toBuilder().setCompressionType(gzip ? SocketMessage.CompressionType.GZIP : SocketMessage.CompressionType.NONE)
        .setPayload(ByteString.copyFrom(compressed(cmd.getMsg().getPayload().toByteArray(), gzip))).build().toByteArray();
      channel = new EmbeddedChannel(new KuaishouCodecHandler(), new KuaishouBinaryFrameHandler(List.of((IKuaishouMsgListener) listener), 1L));
    }
    try { channel.writeInbound(new BinaryWebSocketFrame(Unpooled.wrappedBuffer(wire))); check(events.size() == 1, "Each PK frame reaches raw callback exactly once"); }
    finally { channel.finishAndReleaseAll(); }
  }
  private static void platform(String name) throws Exception {
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, name);
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
  }
  public static void main(String[] args) throws Exception {
    Class.forName(Collector.class.getName());
    System.setOut(new PrintStream(OutputStream.nullOutputStream())); System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    long now = System.currentTimeMillis();
    var start = dy("WebcastLinkMicBattleMethod", battle(now, false));
    var end = dy("WebcastLinkMicBattleFinishMethod", battle(now, false));
    var refresh = dy("WebcastLinkMicArmiesMethod", battle(now, true));
    var statistic = ks(PayloadType.SC_PK_STATISTIC, SCLiveMultiPkStatistic.newBuilder().setPkId("ks-fixture-round").setTime(now).setStatisticVersion(8).build().toByteString());
    var linkEnd = ks(PayloadType.SC_PIP_ENDED, SCWebPipEnded.newBuilder().setTime(now).build().toByteString());
    var event = PkEvents.decode(start, now);
    check(event.path("pk").path("battleId").asText().equals("18446744073709551614"), "uint64 ID remains exact string");
    check(event.path("pk").path("endsAt").asLong() == now + 290_000, "Schema duration uses seconds with explicit start_time_ms");
    check(PkEvents.decode(start, now + 1).path("event_id").equals(event.path("event_id")), "Replay uses stable ID");
    check(PkEvents.decode(end, now).path("pk").path("phase").asText().equals("ended"), "Explicit finish only");
    check(PkEvents.decode(refresh, now).path("pk").path("battleId").isNull(), "Armies cannot invent a battle ID");
    check(PkEvents.decode(refresh, now).path("pk").path("reason").asText().equals("battle-refresh"), "Armies only refreshes existing battle");
    check(!PkEvents.decode(statistic, now).path("pk").has("endsAt"), "KS time never becomes a timer");
    check(!PkEvents.decode(linkEnd, now).path("pk").has("result"), "Link ended never invents a winner");
    check(PkEvents.decode(start, now + 100_000) == null, "Stale source timestamp rejected");
    check(PkEvents.decode(start, now - 31_000) == null, "Future source timestamp rejected");
    check(PkEvents.decode(statistic, now + 100_000) == null, "Stale KS source timestamp rejected");
    check(PkEvents.decode(dy("WebcastChatMessage", battle(now, false)), now) == null, "PK words in chat are not evidence");
    check(PkEvents.decode(ks(PayloadType.SC_PIP_STARTED, SCWebPipEnded.newBuilder().setTime(now).build().toByteString()), now) == null, "Ordinary linking never starts PK");
    check(PkEvents.decode(ks(PayloadType.SC_PK_INVITATION, statistic.getMsg().getPayload()), now) == null, "Invitation never starts PK");
    check(PkEvents.decode(ks(PayloadType.SC_PK_STATISTIC, SCLiveMultiPkStatistic.newBuilder().setTime(now).build().toByteString()), now) == null, "Missing KS round rejected");
    check(PkEvents.decode(dy("WebcastLinkMicBattleMethod", bytes(out -> out.writeBytes(1, Common.newBuilder().setMsgId(1).build().toByteString()))), now) == null, "Missing battle rejected");
    fails(dy("WebcastLinkMicBattleMethod", ByteString.copyFrom(new byte[]{10, 5, 1})));
    fails(dy("WebcastLinkMicBattleMethod", ByteString.copyFrom(new byte[512 * 1024 + 1])));
    fails(ks(PayloadType.SC_PK_STATISTIC, ByteString.EMPTY));
    for (boolean gzip : new boolean[]{false, true}) { pipeline(start, gzip); pipeline(end, gzip); pipeline(refresh, gzip); pipeline(statistic, gzip); pipeline(linkEnd, gzip); }
    // Exercise the actual production Collector listener, not just our decoder.
    platform("douyin"); var dl = Collector.listener(IDouyinMsgListener.class);
    var onMsg = java.util.Arrays.stream(IDouyinMsgListener.class.getMethods()).filter(m -> m.getName().equals("onMsg") && m.getParameterCount() == 1).findFirst().orElseThrow();
    onMsg.invoke(dl, start); onMsg.invoke(dl, end); onMsg.invoke(dl, refresh);
    platform("kuaishou"); var kl = Collector.listener(IKuaishouMsgListener.class);
    var konMsg = java.util.Arrays.stream(IKuaishouMsgListener.class.getMethods()).filter(m -> m.getName().equals("onMsg") && m.getParameterCount() == 1).findFirst().orElseThrow();
    konMsg.invoke(kl, statistic); konMsg.invoke(kl, linkEnd);
    new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8).println("PASS: PK bounded schemas, NONE/GZIP pipelines, actual Collector, uint64 IDs, timestamps, stable IDs, no chat/link invitation inference or invented score/result.");
  }
}
