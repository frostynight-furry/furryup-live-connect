package local.furryup;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.protobuf.ByteString;
import com.google.protobuf.MessageLite;
import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPOutputStream;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.*;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.PayloadTypeOuterClass.PayloadType;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCWebFeedPushOuterClass.SCWebFeedPush;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SimpleUserInfoOuterClass.SimpleUserInfo;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SocketMessageOuterClass.SocketMessage;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.WebShareFeedOuterClass.WebShareFeed;
import tech.ordinaryroad.live.chat.client.kuaishou.listener.IKuaishouMsgListener;
import tech.ordinaryroad.live.chat.client.kuaishou.netty.handler.KuaishouBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.kuaishou.netty.handler.KuaishouCodecHandler;

/** Offline binary frames through the actual SDK codec, raw callback and normal dispatch. */
public final class KuaishouExtraEventsFixture {
  private static final SimpleUserInfo USER = SimpleUserInfo.newBuilder().setPrincipalId("share-viewer")
    .setUserName("快手观众❄️🐾").setHeadUrl("https://tx2.a.yximgs.com/uhead/fixture-share.png").build();

  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static WebShareFeed share(String id, long time) {
    return WebShareFeed.newBuilder().setId(id).setTime(time).setUser(USER).setThirdPartyPlatform(1).build();
  }

  private static KuaishouCmdMsg command(PayloadType type, MessageLite payload) {
    return new KuaishouCmdMsg(SocketMessage.newBuilder().setPayloadType(type)
      .setCompressionType(SocketMessage.CompressionType.NONE).setPayload(payload.toByteString()).build());
  }

  private static BinaryWebSocketFrame frame(SCWebFeedPush feed, boolean gzip) throws IOException {
    byte[] payload = feed.toByteArray();
    if (gzip) {
      var bytes = new ByteArrayOutputStream();
      try (var out = new GZIPOutputStream(bytes)) { out.write(payload); }
      payload = bytes.toByteArray();
    }
    var socket = SocketMessage.newBuilder().setPayloadType(PayloadType.SC_FEED_PUSH)
      .setCompressionType(gzip ? SocketMessage.CompressionType.GZIP : SocketMessage.CompressionType.NONE)
      .setPayload(ByteString.copyFrom(payload)).build();
    return new BinaryWebSocketFrame(Unpooled.wrappedBuffer(socket.toByteArray()));
  }

  private static SCWebFeedPush mixedFeed(String giftMergeKey) {
    return SCWebFeedPush.newBuilder().setDisplayWatchingCount("12").setDisplayLikeCount("34")
      .addShareFeeds(share("share-1", 1700000000000L)).addShareFeeds(share("share-2", 1700000000001L))
      .addCommentFeeds(WebCommentFeedOuterClass.WebCommentFeed.newBuilder().setId("comment-1").setUser(USER).setContent("欢迎❄️"))
      .addGiftFeeds(WebGiftFeedOuterClass.WebGiftFeed.newBuilder().setId("gift-1").setUser(USER)
        .setGiftId(99995).setMergeKey(giftMergeKey).setBatchSize(1).setComboCount(1))
      .addLikeFeeds(WebLikeFeedOuterClass.WebLikeFeed.newBuilder().setId("like-1").setUser(USER))
      .addSystemNoticeFeeds(WebSystemNoticeFeedOuterClass.WebSystemNoticeFeed.newBuilder()
        .setId("notice-1").setUser(USER).setContent("系统公告，不能猜成入场或关注"))
      .build();
  }

  private static void verifyPipeline(boolean gzip) throws Exception {
    var calls = new HashMap<String, Integer>();
    var shares = new ArrayList<ObjectNode>();
    IKuaishouMsgListener listener = (IKuaishouMsgListener) Proxy.newProxyInstance(
      IKuaishouMsgListener.class.getClassLoader(), new Class<?>[]{IKuaishouMsgListener.class}, (proxy, method, args) -> {
        calls.merge(method.getName(), 1, Integer::sum);
        if (method.getName().equals("onMsg")) shares.addAll(KuaishouExtraEvents.decode(args[args.length - 1]));
        return null;
      });
    var channel = new EmbeddedChannel(new KuaishouCodecHandler(), new KuaishouBinaryFrameHandler(List.of(listener), 1L));
    try {
      // The SDK retains combo counters statically. Each independent pipeline
      // verification needs its own transaction key before the production emit.
      channel.writeInbound(frame(mixedFeed(gzip ? "verify-gzip-gift" : "verify-plain-gift"), gzip));
      check(shares.size() == 2, "Both shares reach raw onMsg for " + (gzip ? "GZIP" : "NONE"));
      check(calls.getOrDefault("onMsg", 0) == 1, "One raw callback per socket frame");
      check(calls.getOrDefault("onDanmuMsg", 0) == 1, "Comment remains one SDK callback");
      check(calls.getOrDefault("onGiftMsg", 0) == 1, "Gift remains one SDK callback");
      check(calls.getOrDefault("onLikeMsg", 0) == 1, "Like remains one SDK callback");
      check(calls.getOrDefault("onRoomStatsMsg", 0) == 1, "Statistics remain one SDK callback");
      check(calls.getOrDefault("onOtherCmdMsg", 0) == 0, "Share is lost if only onOtherCmdMsg is used");
    } finally { channel.finishAndReleaseAll(); }
  }

  private static void emitProduction() throws Exception {
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, "kuaishou");
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
    var apis = tech.ordinaryroad.live.chat.client.codec.kuaishou.api.KuaishouApis.RESULT_CACHE;
    apis.put(tech.ordinaryroad.live.chat.client.codec.kuaishou.api.KuaishouApis.KEY_RESULT_CACHE_GIFT_ITEMS,
      Map.of("99995", new tech.ordinaryroad.live.chat.client.codec.kuaishou.api.KuaishouApis.GiftInfo("分享帧礼物", "")));
    var channel = new EmbeddedChannel(new KuaishouCodecHandler(),
      new KuaishouBinaryFrameHandler(List.of(Collector.listener(IKuaishouMsgListener.class)), 1L));
    try {
      channel.writeInbound(frame(mixedFeed("production-share-fixture-gift"), true));
      // Replay should carry the same share source IDs for host-side deduplication.
      channel.writeInbound(frame(SCWebFeedPush.newBuilder().addShareFeeds(share("share-1", 1700000000000L)).build(), false));
    } finally { channel.finishAndReleaseAll(); }
  }

  public static void main(String[] args) throws Exception {
    // Preserve Collector's UTF-8 wire output before disabling dependency logging.
    Class.forName(Collector.class.getName());
    System.setOut(new PrintStream(OutputStream.nullOutputStream()));
    System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    var result = KuaishouExtraEvents.decode(command(PayloadType.SC_FEED_PUSH, mixedFeed("decoder-only-gift")));
    check(result.size() == 2, "Only share feeds are decoded");
    var snapshot = KuaishouExtraEvents.snapshot(command(PayloadType.SC_FEED_PUSH, mixedFeed("snapshot-only-gift")));
    check(snapshot != null && snapshot.path("watching_count").asText().equals("12")
      && snapshot.path("liked_count").asText().equals("34"), "Explicit platform counter snapshot is retained");
    var zeros = SCWebFeedPush.newBuilder().setDisplayWatchingCount("0").setDisplayLikeCount("0").build();
    var zeroSnapshot = KuaishouExtraEvents.snapshot(command(PayloadType.SC_FEED_PUSH, zeros));
    check(zeroSnapshot != null && zeroSnapshot.has("watching_count") && zeroSnapshot.has("liked_count")
      && zeroSnapshot.path("watching_count").asInt(-1) == 0 && zeroSnapshot.path("liked_count").asInt(-1) == 0,
      "Explicit zero counters are retained");
    check(KuaishouExtraEvents.snapshot(command(PayloadType.SC_FEED_PUSH, SCWebFeedPush.getDefaultInstance())) == null,
      "Missing counters are not fabricated zero snapshots");
    var invalidSnapshot = SCWebFeedPush.newBuilder().setDisplayWatchingCount("1.2万").setDisplayLikeCount("invalid").build();
    check(KuaishouExtraEvents.snapshot(command(PayloadType.SC_FEED_PUSH, invalidSnapshot)) == null,
      "Rounded or invalid counters are not fabricated snapshots");
    var partialSnapshot = KuaishouExtraEvents.snapshot(command(PayloadType.SC_FEED_PUSH,
      SCWebFeedPush.newBuilder().setDisplayWatchingCount("7").setDisplayLikeCount("invalid").build()));
    check(partialSnapshot != null && partialSnapshot.path("watching_count").asInt() == 7
      && !partialSnapshot.has("liked_count"), "A valid counter survives an invalid companion counter");
    check(KuaishouExtraEvents.snapshot(null) == null, "Null snapshot is ignored");
    var event = result.getFirst();
    check(event.path("event_type").asText().equals("share"), "Share event type");
    check(event.path("source_msg_id").asText().equals("kuaishou-share:share-1"), "Wire ID is retained");
    check(event.path("event_id").equals(event.path("source_msg_id")), "Stable event ID");
    check(event.path("user_id").asText().equals(USER.getPrincipalId()), "Actual sender ID");
    check(event.path("user_name").asText().equals(USER.getUserName()), "Unicode sender name");
    check(event.path("avatar_url").asText().equals(USER.getHeadUrl()), "Supplied sender avatar");
    check(event.path("count").asInt() == 1, "One share per feed");
    check(!event.has("user_identity_hidden"), "Public share retains its ordinary identity");
    var mysteryUser = USER.toBuilder().clearHeadUrl().setUnknownFields(com.google.protobuf.UnknownFieldSet.newBuilder()
      .addField(4, com.google.protobuf.UnknownFieldSet.Field.newBuilder().addVarint(1).build()).build()).build();
    var mysteryShare = SCWebFeedPush.newBuilder().addShareFeeds(share("mystery-share", 1700000000002L)
      .toBuilder().setUser(mysteryUser)).build();
    var mysteryEvent = KuaishouExtraEvents.decode(command(PayloadType.SC_FEED_PUSH, mysteryShare)).getFirst();
    check(mysteryEvent.path("user_identity_hidden").asBoolean() && !mysteryEvent.has("avatar_url"),
      "Share binary decoding preserves official mystery field 4 without inventing an avatar");
    var mysteryWithAvatar = SCWebFeedPush.newBuilder().addShareFeeds(share("mystery-avatar", 1700000000003L)
      .toBuilder().setUser(mysteryUser.toBuilder().setHeadUrl(USER.getHeadUrl()))).build();
    var suppliedMystery = KuaishouExtraEvents.decode(command(PayloadType.SC_FEED_PUSH, mysteryWithAvatar)).getFirst();
    check(suppliedMystery.path("user_identity_hidden").asBoolean() && suppliedMystery.path("avatar_url").asText().equals(USER.getHeadUrl()),
      "Hidden share keeps only its supplied message-local avatar");
    var outsideShare = SCWebFeedPush.newBuilder().addShareFeeds(share("outside-share", 1700000000004L)
      .toBuilder().setUser(USER.toBuilder().setPrincipalId("OUTSIDE"))).build();
    check(KuaishouExtraEvents.decode(command(PayloadType.SC_FEED_PUSH, outsideShare)).getFirst().path("user_identity_hidden").asBoolean(),
      "Outside shares do not become stable identities");
    var noId = SCWebFeedPush.newBuilder().addShareFeeds(share("", 1700000000002L)).build();
    var noIdEvent = KuaishouExtraEvents.decode(command(PayloadType.SC_FEED_PUSH, noId)).getFirst();
    check(noIdEvent.path("event_id").asText().startsWith("kuaishou-share:sha256:"), "Fallback hashes the actual feed");
    check(noIdEvent.equals(KuaishouExtraEvents.decode(command(PayloadType.SC_FEED_PUSH, noId)).getFirst()), "Replay retains fallback ID");
    check(KuaishouExtraEvents.decode(null).isEmpty(), "Null is ignored");
    check(KuaishouExtraEvents.decode(new KuaishouCmdMsg()).isEmpty(), "Empty command is ignored");
    check(KuaishouExtraEvents.decode(new Object()).isEmpty(), "Other platform objects are ignored");
    var missingUser = SCWebFeedPush.newBuilder().addShareFeeds(WebShareFeed.newBuilder().setId("no-user"))
      .addShareFeeds(WebShareFeed.newBuilder().setId("empty-user").setUser(SimpleUserInfo.getDefaultInstance())).build();
    check(KuaishouExtraEvents.decode(command(PayloadType.SC_FEED_PUSH, missingUser)).isEmpty(), "Missing users never create fake viewers");
    var watching = SCWebLiveWatchingUsersOuterClass.SCWebLiveWatchingUsers.newBuilder()
      .addWatchingUser(WebWatchingUserInfoOuterClass.WebWatchingUserInfo.newBuilder().setUser(USER)).build();
    check(KuaishouExtraEvents.decode(command(PayloadType.SC_LIVE_WATCHING_LIST, watching)).isEmpty(), "Watching list is not a newcomer feed");
    var ack = SCWebEnterRoomAckOuterClass.SCWebEnterRoomAck.newBuilder().setHeartbeatIntervalMs(10000).build();
    check(KuaishouExtraEvents.decode(command(PayloadType.SC_ENTER_ROOM_ACK, ack)).isEmpty(), "Connection acknowledgement is not viewer entry");
    var malformed = new KuaishouCmdMsg(SocketMessage.newBuilder().setPayloadType(PayloadType.SC_FEED_PUSH)
      .setPayload(ByteString.copyFrom(new byte[]{98, 5, 10})).build());
    try { KuaishouExtraEvents.decode(malformed); throw new AssertionError("Truncated share must fail"); }
    catch (IOException expected) { }
    var oversized = new KuaishouCmdMsg(SocketMessage.newBuilder().setPayloadType(PayloadType.SC_FEED_PUSH)
      .setPayload(ByteString.copyFrom(new byte[512 * 1024 + 1])).build());
    try { KuaishouExtraEvents.decode(oversized); throw new AssertionError("Payload size limit"); }
    catch (IOException expected) { }
    var tooMany = SCWebFeedPush.newBuilder();
    for (int i = 0; i < 257; i++) tooMany.addShareFeeds(share("share-" + i, i));
    try { KuaishouExtraEvents.decode(command(PayloadType.SC_FEED_PUSH, tooMany.build())); throw new AssertionError("Share batch limit"); }
    catch (IOException expected) { }
    verifyPipeline(false); verifyPipeline(true);
    if (args.length > 0 && args[0].equals("--emit")) emitProduction();
    else new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, java.nio.charset.StandardCharsets.UTF_8)
      .println("PASS: Kuaishou raw shares/counters, stable IDs, binary NONE/GZIP SDK dispatch, isolated combo fixtures, actual zero versus absent/invalid snapshots, malformed limits and no invented newcomers.");
    System.exit(0);
  }
}
