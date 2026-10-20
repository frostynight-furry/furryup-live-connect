package local.furryup;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.protobuf.ByteString;
import com.google.protobuf.UnknownFieldSet;
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
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.Message;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.Image;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.HeadersList;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.PayGrade;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.PushFrame;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.Response;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.RoomUserSeqMessage;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.RoomUserSeqMessageContributor;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.User;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.PayloadTypeOuterClass.PayloadType;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCWebLiveWatchingUsersOuterClass.SCWebLiveWatchingUsers;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SimpleUserInfoOuterClass.SimpleUserInfo;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SocketMessageOuterClass.SocketMessage;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.WebWatchingUserInfoOuterClass.WebWatchingUserInfo;
import tech.ordinaryroad.live.chat.client.douyin.listener.IDouyinMsgListener;
import tech.ordinaryroad.live.chat.client.douyin.netty.handler.DouyinBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.douyin.netty.handler.DouyinCodecHandler;
import tech.ordinaryroad.live.chat.client.kuaishou.listener.IKuaishouMsgListener;
import tech.ordinaryroad.live.chat.client.kuaishou.netty.handler.KuaishouBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.kuaishou.netty.handler.KuaishouCodecHandler;

/** Offline protocol fixtures; no credentials, room requests or platform network calls. */
public final class ViewerSnapshotsFixture {
  private static final SimpleUserInfo USER = SimpleUserInfo.newBuilder()
    .setPrincipalId("viewer-fixture").setUserName("测试观众❄️🐾")
    .setHeadUrl("https://tx2.a.yximgs.com/uhead/fixture-viewer.png").build();

  private static SimpleUserInfo hidden(SimpleUserInfo user) {
    // OrdinaryRoad 1.5.8 preserves the current official bool mystery field 4.
    return user.toBuilder().setUnknownFields(UnknownFieldSet.newBuilder().addField(4,
      UnknownFieldSet.Field.newBuilder().addVarint(1).build()).build()).build();
  }

  private static void check(boolean result, String message) {
    if (!result) throw new AssertionError(message);
  }

  private static KuaishouCmdMsg kuaishou(SCWebLiveWatchingUsers list) {
    return kuaishou(PayloadType.SC_LIVE_WATCHING_LIST, list.toByteString());
  }

  private static KuaishouCmdMsg kuaishou(PayloadType type, ByteString payload) {
    return new KuaishouCmdMsg(SocketMessage.newBuilder().setPayloadType(type).setPayload(payload).build());
  }

  private static DouyinCmdMsg douyin(RoomUserSeqMessage list) {
    return new DouyinCmdMsg(Message.newBuilder().setMethod("WebcastRoomUserSeqMessage")
      .setPayload(list.toByteString()).build());
  }

  private static void expectFailure(Object command, String description) throws Exception {
    try { ViewerSnapshots.decode(command); throw new AssertionError(description); }
    catch (IOException expected) { }
  }

  private static BinaryWebSocketFrame frame(SCWebLiveWatchingUsers list, boolean gzip) throws IOException {
    byte[] payload = list.toByteArray();
    if (gzip) {
      var bytes = new ByteArrayOutputStream();
      try (var out = new GZIPOutputStream(bytes)) { out.write(payload); }
      payload = bytes.toByteArray();
    }
    var socket = SocketMessage.newBuilder().setPayloadType(PayloadType.SC_LIVE_WATCHING_LIST)
      .setCompressionType(gzip ? SocketMessage.CompressionType.GZIP : SocketMessage.CompressionType.NONE)
      .setPayload(ByteString.copyFrom(payload)).build();
    return new BinaryWebSocketFrame(Unpooled.wrappedBuffer(socket.toByteArray()));
  }

  private static void verifyPipeline(SCWebLiveWatchingUsers list, boolean gzip) throws Exception {
    var snapshots = new ArrayList<ObjectNode>();
    var rawCalls = new int[]{0};
    IKuaishouMsgListener listener = (IKuaishouMsgListener) Proxy.newProxyInstance(
      IKuaishouMsgListener.class.getClassLoader(), new Class<?>[]{IKuaishouMsgListener.class}, (proxy, method, args) -> {
        if (method.getName().equals("onMsg")) {
          rawCalls[0]++;
          ObjectNode event = ViewerSnapshots.decode(args[args.length - 1]);
          if (event != null) snapshots.add(event);
        }
        return null;
      });
    var channel = new EmbeddedChannel(new KuaishouCodecHandler(), new KuaishouBinaryFrameHandler(List.of(listener), 1L));
    try {
      channel.writeInbound(frame(list, gzip));
      check(rawCalls[0] == 1 && snapshots.size() == 1, "340 frame reaches exactly one raw snapshot callback");
      check(snapshots.getFirst().path("viewer_snapshot").path("viewers").size() == 2,
        "Only two public identities survive SDK NONE/GZIP decoding");
      check(snapshots.getFirst().path("viewer_snapshot").path("viewers").get(0)
        .path("avatarUrl").asText().equals(USER.getHeadUrl()), "Supplied avatar survives the real SDK pipeline");
    } finally { channel.finishAndReleaseAll(); }
  }

  private static BinaryWebSocketFrame douyinFrame(RoomUserSeqMessage list, boolean gzip) throws IOException {
    var response = Response.newBuilder().addMessagesList(douyin(list).getMsg()).build();
    byte[] payload = response.toByteArray();
    if (gzip) {
      var bytes = new ByteArrayOutputStream();
      try (var out = new GZIPOutputStream(bytes)) { out.write(payload); }
      payload = bytes.toByteArray();
    }
    var push = PushFrame.newBuilder().setPayloadType("msg")
      .addHeadersList(HeadersList.newBuilder().setKey("compress_type").setValue(gzip ? "gzip" : "none"))
      .setPayload(ByteString.copyFrom(payload)).build();
    return new BinaryWebSocketFrame(Unpooled.wrappedBuffer(push.toByteArray()));
  }

  private static void verifyDouyinPipeline(RoomUserSeqMessage list, boolean gzip) throws Exception {
    var snapshots = new ArrayList<ObjectNode>();
    var rawCalls = new int[]{0};
    IDouyinMsgListener listener = (IDouyinMsgListener) Proxy.newProxyInstance(
      IDouyinMsgListener.class.getClassLoader(), new Class<?>[]{IDouyinMsgListener.class}, (proxy, method, args) -> {
        if (method.getName().equals("onMsg")) {
          rawCalls[0]++;
          ObjectNode event = ViewerSnapshots.decode(args[args.length - 1]);
          if (event != null) snapshots.add(event);
        }
        return null;
      });
    var channel = new EmbeddedChannel(new DouyinCodecHandler(), new DouyinBinaryFrameHandler(List.of(listener), 1L));
    try {
      channel.writeInbound(douyinFrame(list, gzip));
      check(rawCalls[0] == 1 && snapshots.size() == 1, "One contributor message reaches exactly one raw callback");
      check(snapshots.getFirst().path("viewer_snapshot").path("presenceEvidence").asText().equals("unknown"),
        "Actual SDK contributor dispatch retains unknown online evidence");
    } finally { channel.finishAndReleaseAll(); }
  }

  private static void platform(String platform) throws Exception {
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, platform);
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
  }

  public static void main(String[] args) throws Exception {
    Class.forName(Collector.class.getName());
    System.setOut(new PrintStream(OutputStream.nullOutputStream()));
    System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    var watching = SCWebLiveWatchingUsers.newBuilder()
      .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(USER).setTuhao(true).setDisplayKsCoin("1.2万"))
      .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(USER.toBuilder().setPrincipalId("offline-fixture"))
        .setOffline(true))
      .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(hidden(USER.toBuilder().setPrincipalId("hidden-fixture").build())))
      .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(USER.toBuilder().setPrincipalId("OUTSIDE"))).build();
    var first = ViewerSnapshots.decode(kuaishou(watching));
    var snapshot = first.path("viewer_snapshot");
    var active = snapshot.path("viewers").get(0);
    check(first.path("event_type").asText().equals("viewer_snapshot"), "Dedicated snapshot event");
    check(snapshot.path("source").asText().equals("kuaishou-live-watching-list")
      && snapshot.path("presenceEvidence").asText().equals("online-list") && !snapshot.path("complete").asBoolean(),
      "Explicit watching-list evidence is partial");
    check(active.path("online").asBoolean() && active.path("highWealth").asBoolean(), "Default false offline means online; tuhao is retained");
    check(active.path("userId").asText().equals(USER.getPrincipalId())
      && active.path("userName").asText().equals(USER.getUserName()), "Stable identity and Unicode name");
    check(active.path("avatarUrl").asText().equals(USER.getHeadUrl()) && !active.has("rank"),
      "Supplied CDN avatar is retained; watching list order is not a rank");
    check(active.path("userLevel").isNull() && active.path("wealthLevel").isNull() && !active.has("displayKsCoin"),
      "No invented levels or conversion from display coins");
    var offline = snapshot.path("viewers").get(1);
    check(!offline.path("online").asBoolean() && !offline.path("highWealth").asBoolean(), "Offline and ordinary flags retained");
    var next = ViewerSnapshots.decode(kuaishou(watching));
    check(next.path("viewer_snapshot").path("revision").asLong() > snapshot.path("revision").asLong()
      && !first.path("source_msg_id").equals(next.path("source_msg_id")), "Repeated lists remain fresh observations");
    var empty = ViewerSnapshots.decode(kuaishou(SCWebLiveWatchingUsers.getDefaultInstance()));
    check(empty.path("viewer_snapshot").path("viewers").isEmpty()
      && !empty.path("viewer_snapshot").path("complete").asBoolean(), "Empty partial list stays partial");
    var invalidUsers = SCWebLiveWatchingUsers.newBuilder()
      .addWatchingUser(WebWatchingUserInfo.getDefaultInstance())
      .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(SimpleUserInfo.getDefaultInstance())).build();
    check(ViewerSnapshots.decode(kuaishou(invalidUsers)).path("viewer_snapshot").path("viewers").isEmpty(), "No fabricated users from missing IDs");
    var hiddenConflict = SCWebLiveWatchingUsers.newBuilder()
      .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(USER))
      .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(hidden(USER))).build();
    check(ViewerSnapshots.decode(kuaishou(hiddenConflict)).path("viewer_snapshot").path("viewers").isEmpty(),
      "A hidden duplicate suppresses that identity across the whole snapshot");
    for (String id : List.of("outside", "unknown", "anonymous", "undefined", "null", " padded", "padded ", "bad\nid")) {
      var invalidId = SCWebLiveWatchingUsers.newBuilder()
        .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(USER.toBuilder().setPrincipalId(id))).build();
      check(ViewerSnapshots.decode(kuaishou(invalidId)).path("viewer_snapshot").path("viewers").isEmpty(),
        "Placeholder, whitespace or control-character identity is not retained");
    }
    for (String url : List.of("http://tx2.a.yximgs.com/avatar.png", "https://tx2.a.yximgs.com.evil.invalid/avatar.png",
        "https://user:pass@tx2.a.yximgs.com/avatar.png", "https://tx2.a.yximgs.com:8443/avatar.png",
        "data:image/png;base64,AAAA", "https://tx2.a.yximgs.com/a\nb", "https://tx2.a.yximgs.com/" + "a".repeat(4096))) {
      var invalidAvatar = SCWebLiveWatchingUsers.newBuilder()
        .addWatchingUser(WebWatchingUserInfo.newBuilder().setUser(USER.toBuilder().setHeadUrl(url))).build();
      var viewer = ViewerSnapshots.decode(kuaishou(invalidAvatar)).path("viewer_snapshot").path("viewers").get(0);
      check(viewer.path("userId").asText().equals(USER.getPrincipalId()) && !viewer.has("avatarUrl"),
        "Invalid avatar is omitted without dropping a valid viewer");
    }
    check(ViewerSnapshots.decode(null) == null && ViewerSnapshots.decode(new Object()) == null, "Unrelated objects ignored");
    check(ViewerSnapshots.decode(kuaishou(PayloadType.SC_ENTER_ROOM_ACK, watching.toByteString())) == null,
      "Connection acknowledgement never becomes a viewer snapshot");
    expectFailure(kuaishou(PayloadType.SC_LIVE_WATCHING_LIST, ByteString.copyFrom(new byte[]{10, 5, 10})), "Malformed protobuf rejected");
    expectFailure(kuaishou(PayloadType.SC_LIVE_WATCHING_LIST, ByteString.copyFrom(new byte[512 * 1024 + 1])), "Oversized payload rejected");
    expectFailure(kuaishou(SCWebLiveWatchingUsers.newBuilder().addWatchingUser(watching.getWatchingUser(0))
      .addWatchingUser(watching.getWatchingUser(0)).build()), "Duplicate identities rejected");
    var tooMany = SCWebLiveWatchingUsers.newBuilder();
    for (int index = 0; index < 501; index++) tooMany.addWatchingUser(WebWatchingUserInfo.newBuilder()
      .setUser(USER.toBuilder().setPrincipalId("viewer-" + index)));
    expectFailure(kuaishou(tooMany.build()), "Oversized viewer batch rejected");
    var largeAvatars = SCWebLiveWatchingUsers.newBuilder();
    String longAvatar = "https://tx2.a.yximgs.com/uhead/" + "a".repeat(3900);
    for (int index = 0; index < 100; index++) largeAvatars.addWatchingUser(WebWatchingUserInfo.newBuilder()
      .setUser(USER.toBuilder().setPrincipalId("large-avatar-" + index).setHeadUrl(longAvatar)));
    check(largeAvatars.build().getSerializedSize() < 512 * 1024, "Large URL fixture stays within the raw protobuf bound");
    var boundedEvent = ViewerSnapshots.decode(kuaishou(largeAvatars.build()));
    check(boundedEvent.toString().getBytes(StandardCharsets.UTF_8).length < 192 * 1024
      && boundedEvent.path("viewer_snapshot").path("viewers").size() > 0
      && boundedEvent.path("viewer_snapshot").path("viewers").size() < 100
      && !boundedEvent.path("viewer_snapshot").path("complete").asBoolean(),
      "Large valid avatars keep a bounded partial snapshot instead of breaking stdout");

    var user = User.newBuilder().setId(9007199254740993L).setNickName("抖音观众❄️🐾")
      .setLevel(12).setPayGrade(PayGrade.newBuilder().setLevel(55))
      .setAvatarThumb(Image.newBuilder().addUrlListList("https://example.invalid/avatar.png")
        .addUrlListList("https://p1.douyinpic.com/fixture-avatar.png#fragment")).build();
    var ranks = RoomUserSeqMessage.newBuilder()
      .addRanksList(RoomUserSeqMessageContributor.newBuilder().setUser(user).setRank(1))
      .addRanksList(RoomUserSeqMessageContributor.newBuilder().setUser(User.newBuilder().setId(2).setNickName("普通观众")))
      .addRanksList(RoomUserSeqMessageContributor.newBuilder().setUser(user.toBuilder().setId(3)).setIsHidden(true)).build();
    var rankSnapshot = ViewerSnapshots.decode(douyin(ranks)).path("viewer_snapshot");
    var contributor = rankSnapshot.path("viewers").get(0);
    check(rankSnapshot.path("presenceEvidence").asText().equals("unknown") && !rankSnapshot.path("complete").asBoolean(),
      "Contributor rankings never prove current online presence");
    check(contributor.path("online").isNull() && contributor.path("userId").asText().equals("9007199254740993"),
      "Unknown online state and exact large ID");
    check(contributor.path("userLevel").asInt() == 12 && contributor.path("wealthLevel").asInt() == 55
      && contributor.path("rank").asInt() == 1, "Distinct source grade and user level fields");
    check(contributor.path("avatarUrl").asText().equals("https://p1.douyinpic.com/fixture-avatar.png"),
      "Avatar image URL list selects a valid CDN candidate and drops fragments");
    check(rankSnapshot.path("viewers").size() == 2 && rankSnapshot.path("viewers").get(1).path("wealthLevel").isNull()
      && rankSnapshot.path("viewers").get(1).path("userLevel").isNull(), "Hidden users excluded; missing levels stay unknown");
    check(!rankSnapshot.path("viewers").get(1).has("rank") && !rankSnapshot.path("viewers").get(1).has("avatarUrl"),
      "Absent avatar and rank are not fabricated from array position");
    var hiddenRanks = RoomUserSeqMessage.newBuilder()
      .addRanksList(RoomUserSeqMessageContributor.newBuilder().setUser(user).setRank(1))
      .addRanksList(RoomUserSeqMessageContributor.newBuilder().setUser(user).setIsHidden(true)).build();
    check(ViewerSnapshots.decode(douyin(hiddenRanks)).path("viewer_snapshot").path("viewers").isEmpty(),
      "Hidden contributor duplicate cannot disclose a public copy in the same list");
    var mediumAvatar = user.toBuilder().clearAvatarThumb()
      .setAvatarMedium(Image.newBuilder().addUrlListList("https://p1.douyincdn.com/fixture-medium.png")).build();
    var mediumRanks = RoomUserSeqMessage.newBuilder()
      .addRanksList(RoomUserSeqMessageContributor.newBuilder().setUser(mediumAvatar).setRank(501)).build();
    var mediumViewer = ViewerSnapshots.decode(douyin(mediumRanks)).path("viewer_snapshot").path("viewers").get(0);
    check(mediumViewer.path("avatarUrl").asText().equals("https://p1.douyincdn.com/fixture-medium.png")
      && !mediumViewer.has("rank"), "Known alternate avatar field is used; out-of-range rank omitted");
    var malformedDouyin = new DouyinCmdMsg(Message.newBuilder().setMethod("WebcastRoomUserSeqMessage")
      .setPayload(ByteString.copyFrom(new byte[]{18, 5, 10})).build());
    expectFailure(malformedDouyin, "Malformed contributor protobuf rejected");
    verifyPipeline(watching, false); verifyPipeline(watching, true);
    verifyDouyinPipeline(ranks, false); verifyDouyinPipeline(ranks, true);
    if (args.length > 0 && args[0].equals("--emit")) {
      platform("kuaishou");
      var channel = new EmbeddedChannel(new KuaishouCodecHandler(),
        new KuaishouBinaryFrameHandler(List.of(Collector.listener(IKuaishouMsgListener.class)), 1L));
      try { channel.writeInbound(frame(watching, true)); channel.writeInbound(frame(watching, false)); }
      finally { channel.finishAndReleaseAll(); }
      platform("douyin");
      var dyChannel = new EmbeddedChannel(new DouyinCodecHandler(),
        new DouyinBinaryFrameHandler(List.of(Collector.listener(IDouyinMsgListener.class)), 1L));
      try { dyChannel.writeInbound(douyinFrame(ranks, true)); }
      finally { dyChannel.finishAndReleaseAll(); }
    } else new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8)
      .println("PASS: viewer snapshots; actual Kuaishou 340 and Douyin contributor NONE/GZIP dispatch, bounded CDN avatars, hidden/placeholder identities, explicit ranks, online/offline and tuhao flags, partial empty lists, repeat observations, exact IDs and malformed limits.");
    System.exit(0);
  }
}
