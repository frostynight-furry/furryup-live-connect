package local.furryup;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import cn.hutool.core.lang.Pair;
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
import java.util.zip.DeflaterOutputStream;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.MessageMsg;
import tech.ordinaryroad.live.chat.client.bilibili.listener.IBilibiliMsgListener;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliCodecHandler;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliBinaryFrameHandler;
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
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final List<ObjectNode> EMITTED = new ArrayList<>();
  private static boolean emitOnly;
  private static void sample(String platform, ObjectNode event) {
    ObjectNode row = JSON.createObjectNode().put("platform", platform);
    row.set("event", event);
    EMITTED.add(row);
  }
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
  private static MessageMsg bili(String command, String data, long now) throws Exception {
    return JSON.readValue("{\"cmd\":\"" + command + "\",\"pk_id\":9007199254740993,\"timestamp\":" + now / 1000
      + ",\"data\":" + data + "}", MessageMsg.class);
  }
  private static void biliPipeline(MessageMsg message, boolean zlib) throws Exception {
    var events = new ArrayList<ObjectNode>();
    var listener = (IBilibiliMsgListener) Proxy.newProxyInstance(IBilibiliMsgListener.class.getClassLoader(),
      new Class<?>[]{IBilibiliMsgListener.class}, (proxy, method, args) -> {
        if (method.getName().equals("onMsg")) {
          ObjectNode event = PkEvents.decode(args[args.length - 1]);
          if (event != null) events.add(event);
        }
        return null;
      });
    // Include Collector's production listener, as well as the assertion listener,
    // to exercise the actual codec, unknown envelope fields, and dispatch path.
    platform("bilibili");
    var channel = new EmbeddedChannel(new BilibiliCodecHandler(),
      new BilibiliBinaryFrameHandler(emitOnly ? List.of(listener) : List.of(listener, Collector.listener(IBilibiliMsgListener.class)),
        1L, Pair.of(1L, 0L)));
    byte[] body = JSON.writeValueAsBytes(message);
    var frame = Unpooled.buffer();
    frame.writeInt(16 + body.length).writeShort(16).writeShort(0).writeInt(5).writeInt(1).writeBytes(body);
    if (zlib) {
      byte[] plain = new byte[frame.readableBytes()]; frame.readBytes(plain); frame.release();
      var output = new ByteArrayOutputStream();
      try (var zip = new DeflaterOutputStream(output)) { zip.write(plain); }
      byte[] compressed = output.toByteArray();
      frame = Unpooled.buffer().writeInt(16 + compressed.length).writeShort(16).writeShort(2)
        .writeInt(5).writeInt(1).writeBytes(compressed);
    }
    try {
      channel.writeInbound(new BinaryWebSocketFrame(frame));
      check(events.size() == 1, "Bilibili PK socket update is dispatched exactly once");
      check(events.getFirst().path("pk").path("battleId").asText().equals("9007199254740993"), "Bilibili envelope ID survives codec");
    } finally { channel.finishAndReleaseAll(); }
  }
  private static void bilibili(long now) throws Exception {
    String prepared = "{\"room_id\":222,\"uid\":9007199254740995,\"uname\":\"对手雪❄️\","
      + "\"face\":\"http://i0.hdslb.com/avatar.png\",\"pk_votes_name\":\"PK值\"}";
    String started = "{\"pk_start_time\":" + (now / 1000 - 10) + ",\"pk_end_time\":" + (now / 1000 + 290)
      + ",\"pk_votes_name\":\"PK值\",\"init_info\":{\"room_id\":111},\"match_info\":{\"room_id\":222}}";
    String scores = "{\"init_info\":{\"room_id\":111,\"votes\":9007199254740993,\"best_uname\":\"PRIVATE_SUPPORTER\"},"
      + "\"match_info\":{\"room_id\":222,\"votes\":0,\"winner_type\":-1}}";
    var pre = bili("PK_BATTLE_PRE_NEW", prepared, now);
    var start = bili("PK_BATTLE_START_NEW", started, now);
    var update = bili("PK_BATTLE_PROCESS_NEW", scores, now);
    var end = bili("PK_BATTLE_END", scores, now);
    ObjectNode p = PkEvents.decode(pre, now);
    check(p.path("pk").path("phase").asText().equals("preparing"), "Opponent preparation cannot start an active PK");
    var opponent = p.path("pk").path("participants").get(0);
    check(opponent.path("side").asText().equals("opponent"), "Preparation does not assume init/match side");
    check(opponent.path("userId").asText().equals("9007199254740995"), "Opponent identity remains exact");
    check(opponent.path("userName").asText().equals("对手雪❄️"), "Explicit opponent name");
    check(opponent.path("avatarUrl").asText().equals("https://i0.hdslb.com/avatar.png"), "Public avatar is upgraded to HTTPS");
    var hidden = PkEvents.decode(bili("PK_BATTLE_PRE_NEW", prepared.replace("\"uid\":", "\"is_mystery\":true,\"uid\":"), now), now);
    check(!hidden.path("pk").path("participants").get(0).has("userId")
      && !hidden.path("pk").path("participants").get(0).has("avatarUrl"), "Hidden opponent fields are not exposed");
    for (String url : new String[]{"https://i0.hdslb.com.evil.test/a", "https://user:pass@i0.hdslb.com/a", "file:///avatar.png"}) {
      var invalid = PkEvents.decode(bili("PK_BATTLE_PRE", prepared.replace("http://i0.hdslb.com/avatar.png", url), now), now);
      check(!invalid.path("pk").path("participants").get(0).has("avatarUrl"), "Only platform public image hosts survive");
    }
    var s = PkEvents.decode(start, now);
    check(s.path("pk").path("startedAt").asLong() == (now / 1000 - 10) * 1000, "Bilibili seconds convert to epoch milliseconds");
    check(s.path("pk").path("endsAt").asLong() == (now / 1000 + 290) * 1000, "Explicit end time preserved");
    check(!s.path("pk").path("participants").get(0).has("score"), "Missing score remains unknown");
    var zeroDuration = PkEvents.decode(bili("PK_BATTLE_START_NEW",
      started.replace("\"pk_end_time\":" + (now / 1000 + 290), "\"pk_end_time\":" + (now / 1000 - 10))
        .replace("\"PK值\"", "\"   \""), now), now);
    check(zeroDuration != null && !zeroDuration.path("pk").has("endsAt")
      && !zeroDuration.path("pk").has("scoreUnit"), "Zero duration and blank unit stay absent without losing the PK event");
    var u = PkEvents.decode(update, now);
    check(u.path("pk").path("participants").get(0).path("score").asText().equals("9007199254740993"), "Scores exceed JS safe integer without rounding");
    check(u.path("pk").path("participants").get(1).path("score").asText().equals("0"), "Explicit zero score preserved");
    check(!u.toString().contains("PRIVATE_SUPPORTER"), "Supporter names cannot be mistaken for opponent profile");
    var e = PkEvents.decode(end, now);
    check(e.path("pk").path("phase").asText().equals("ended") && !e.path("pk").has("result"), "Explicit end does not guess winner-type codes");
    sample("bilibili", p); sample("bilibili", s); sample("bilibili", u); sample("bilibili", e);
    for (String[] pair : new String[][]{{"PK_BATTLE_PRE", "PK_BATTLE_PRE_NEW", prepared},
        {"PK_BATTLE_START", "PK_BATTLE_START_NEW", started}, {"PK_BATTLE_PROCESS", "PK_BATTLE_PROCESS_NEW", scores}}) {
      check(PkEvents.decode(bili(pair[0], pair[2], now), now).path("event_id")
        .equals(PkEvents.decode(bili(pair[1], pair[2], now), now + 1).path("event_id")), "Mirrored old/new commands deduplicate without receive-time alias");
    }
    check(!u.path("event_id").equals(PkEvents.decode(bili("PK_BATTLE_PROCESS_NEW", scores.replace("9007199254740993", "9007199254740994"), now), now).path("event_id")), "Distinct same-second scores retain identity");
    check(PkEvents.decode(start, now + 100_000) == null, "Stale Bilibili PK update rejected");
    check(PkEvents.decode(start, now - 31_000) == null, "Future Bilibili PK update rejected");
    check(PkEvents.decode(bili("PK_BATTLE_PRE_NEW", prepared.replace("222", "0"), now), now) == null, "Preparation requires explicit opponent room");
    check(PkEvents.decode(bili("PK_BATTLE_PROCESS_NEW", scores.replace("\"room_id\":222", "\"room_id\":111"), now), now) == null, "Conflicting participant identity is rejected");
    for (String value : new String[]{"-1", "1.5", "\"18446744073709551616\"", "\"0001\"", "\"123456789012345678901\""}) {
      var invalid = PkEvents.decode(bili("PK_BATTLE_PROCESS_NEW", scores.replace("9007199254740993", value), now), now);
      check(!invalid.path("pk").path("participants").get(0).has("score"), "Malformed score cannot become zero or be truncated");
    }
    var missing = bili("PK_BATTLE_START_NEW", started, now); missing.getUnknownProperties().remove("pk_id");
    check(PkEvents.decode(missing, now) == null, "Missing round identity never attaches an unrelated PK");
    check(PkEvents.decode(new MessageMsg(), now) == null, "Unset command ignored");
    check(PkEvents.decode(bili("PK_BATTLE_PREPARE_UNKNOWN", prepared, now), now) == null, "Unverified command ignored");
    for (MessageMsg wire : List.of(pre, start, update, end))
      for (boolean zlib : new boolean[]{false, true}) biliPipeline(wire, zlib);
  }
  private static ByteString score(long uid, Long score, Write extra) throws IOException {
    return bytes(out -> {
      out.writeInt64(2, uid);
      if (score != null) out.writeInt64(1, score);
      if (extra != null) extra.run(out);
    });
  }
  private static DouyinCmdMsg scoreUpdate(long now, int type, long battleId, List<ByteString> scores, Write extra) throws IOException {
    return dy("WebcastLinkMicMethod", bytes(out -> {
      out.writeBytes(1, Common.newBuilder().setMsgId(54321).setCreateTime(now).build().toByteString());
      out.writeInt64(2, type);
      out.writeInt64(104, battleId);
      for (ByteString score : scores) out.writeBytes(17, score);
      if (extra != null) extra.run(out);
    }));
  }
  private static void douyinScores(long now) throws Exception {
    var first = score(9007199254740993L, 9007199254740995L, out -> out.writeString(21, "9007199254740993"));
    var second = score(999L, 0L, null);
    var update = scoreUpdate(now, 202, 12345, List.of(first, second), out -> {
      out.writeString(114, "12345");
      // Contributors carry their own score. They must not become PK sides.
      out.writeBytes(22, bytes(inner -> inner.writeInt64(1, 777)));
    });
    var event = PkEvents.decode(update, now);
    check(event.path("pk").path("battleId").asText().equals("12345"), "Update requires its own exact battle identity");
    var participants = event.path("pk").path("participants");
    check(participants.size() == 2 && participants.get(0).path("userId").asText().equals("9007199254740993"), "PK participants are not contributors");
    check(participants.get(0).path("score").asText().equals("9007199254740995"), "Douyin int64 score survives without floating point");
    check(participants.get(1).path("score").asText().equals("0") && !participants.get(1).has("roomId"), "Explicit zero preserved without an invented room mapping");
    sample("douyin", event);
    for (int field : new int[]{4, 7}) {
      var display = score(999, 123456L, out -> out.writeString(field, field == 4 ? "领先 100" : "1万+"));
      var redacted = PkEvents.decode(scoreUpdate(now, 202, 12345, List.of(display), null), now);
      check(!redacted.path("pk").path("participants").get(0).has("score")
        && redacted.path("pk").path("participants").get(0).has("scoreDisplay"), "Relative/blurred display suppresses raw score");
      if (field == 7) sample("douyin", redacted);
    }
    for (String invalid : new String[]{"x".repeat(65), "\n", "   "}) {
      var invalidDisplay = score(999, 123456L, out -> out.writeString(7, invalid));
      var invalidText = PkEvents.decode(scoreUpdate(now, 202, 12345, List.of(invalidDisplay), null), now);
      check(!invalidText.path("pk").path("participants").get(0).has("score")
        && !invalidText.path("pk").path("participants").get(0).has("scoreDisplay"), "Invalid blur text cannot expose raw score");
    }
    for (int type : new int[]{4, 201, 205, 999})
      check(PkEvents.decode(scoreUpdate(now, type, 12345, List.of(first), null), now) == null, "Only documented update type starts score update");
    check(PkEvents.decode(scoreUpdate(now, 202, 0, List.of(first), null), now) == null, "No prior battle inferred for unscoped score");
    check(PkEvents.decode(scoreUpdate(now, 202, 12345, List.of(first), out -> out.writeString(114, "12346")), now) == null, "Conflicting numeric/text battle IDs rejected");
    check(PkEvents.decode(scoreUpdate(now, 202, 12345, List.of(first, first), null), now) == null, "Duplicate participant IDs never merge");
    check(PkEvents.decode(scoreUpdate(now, 202, 12345, List.of(first, second, score(888, 1L, null)), null), now) == null, "Three-party packet is not truncated to two");
    check(PkEvents.decode(scoreUpdate(now, 202, 12345, List.of(score(999, 1L, out -> out.writeInt64(11, 100))), null), now) == null, "Team total cannot become an individual score");
    check(PkEvents.decode(scoreUpdate(now, 202, 12345, List.of(score(999, 1L, out -> out.writeString(21, "1000"))), null), now) == null, "Conflicting participant identity rejected");
    for (Long absentOrInvalid : new Long[]{null, -1L}) {
      var unknown = PkEvents.decode(scoreUpdate(now, 202, 12345, List.of(score(999, absentOrInvalid, null)), null), now);
      check(!unknown.path("pk").path("participants").get(0).has("score"), "Missing and negative scores never become zero or unsigned totals");
    }
    check(PkEvents.decode(update, now + 100_000) == null, "Stale score update rejected");
    fails(scoreUpdate(now, 202, 12345, List.of(score(999, 1L, out -> out.writeString(1, "bad"))), null));
    fails(scoreUpdate(now, 202, 12345, List.of(first), out -> out.writeInt64(104, 12345)));
    var finish = dy("WebcastLinkMicBattleFinishMethod", battle(now, false).concat(bytes(out -> {
      out.writeBytes(4, score(9007199254740993L, 300L, extra -> extra.writeString(8, "9007199254740993")));
      out.writeBytes(4, score(999, 0L, null));
      out.writeBytes(3, ByteString.copyFromUtf8("unread-contributor-rank"));
    })));
    var ended = PkEvents.decode(finish, now);
    check(ended.path("pk").path("phase").asText().equals("ended")
      && ended.path("pk").path("participants").get(0).path("score").asText().equals("300"), "Explicit finish reads only BattleScore rows");
    check(!ended.path("pk").has("result"), "Finish does not infer winner from scores");
    sample("douyin", ended);
    var relativeFinish = dy("WebcastLinkMicBattleFinishMethod", battle(now, false).concat(bytes(out ->
      out.writeBytes(4, score(999, 123456L, extra -> { extra.writeBool(11, true); extra.writeString(12, "领先 100"); })))));
    check(!PkEvents.decode(relativeFinish, now).path("pk").path("participants").get(0).has("score"), "Finish relative flag suppresses score");
    var teamFinish = dy("WebcastLinkMicBattleFinishMethod", battle(now, false).concat(bytes(out ->
      out.writeBytes(4, score(999, 123L, extra -> extra.writeInt64(19, 500))))));
    check(!PkEvents.decode(teamFinish, now).path("pk").has("participants"), "Team scores omitted while actual finish remains");
    for (boolean gzip : new boolean[]{false, true}) { pipeline(update, gzip); pipeline(finish, gzip); }
  }
  public static void main(String[] args) throws Exception {
    emitOnly = java.util.Arrays.asList(args).contains("--emit-events");
    Class.forName(Collector.class.getName());
    System.setOut(new PrintStream(OutputStream.nullOutputStream())); System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    long now = System.currentTimeMillis();
    bilibili(now);
    douyinScores(now);
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
    if (!emitOnly) {
      platform("douyin"); var dl = Collector.listener(IDouyinMsgListener.class);
      var onMsg = java.util.Arrays.stream(IDouyinMsgListener.class.getMethods()).filter(m -> m.getName().equals("onMsg") && m.getParameterCount() == 1).findFirst().orElseThrow();
      onMsg.invoke(dl, start); onMsg.invoke(dl, end); onMsg.invoke(dl, refresh);
      platform("kuaishou"); var kl = Collector.listener(IKuaishouMsgListener.class);
      var konMsg = java.util.Arrays.stream(IKuaishouMsgListener.class.getMethods()).filter(m -> m.getName().equals("onMsg") && m.getParameterCount() == 1).findFirst().orElseThrow();
      konMsg.invoke(kl, statistic); konMsg.invoke(kl, linkEnd);
    }
    if (emitOnly) {
      var output = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
      for (ObjectNode row : EMITTED) output.println(JSON.writeValueAsString(row));
    }
    new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8).println("PASS: Bilibili PK preparation/opponents/scores/start/end, NONE/ZLIB and NONE/GZIP pipelines, actual Collector, exact IDs/scores, timestamp/replay/privacy boundaries; no inferred winners or unsupported multi-party scores.");
  }
}
