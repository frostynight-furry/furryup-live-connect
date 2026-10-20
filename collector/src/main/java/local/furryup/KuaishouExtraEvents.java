package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.PayloadTypeOuterClass.PayloadType;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCWebFeedPushOuterClass.SCWebFeedPush;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCWebLiveWatchingUsersOuterClass.SCWebLiveWatchingUsers;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.WebShareFeedOuterClass.WebShareFeed;

/** Decode genuine feed interactions which OrdinaryRoad 1.5.8 does not dispatch. */
final class KuaishouExtraEvents {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int MAX_PAYLOAD_BYTES = 512 * 1024;
  private static final int MAX_SHARES = 256;

  private KuaishouExtraEvents() {}

  /**
   * Call only from onMsg. The SDK has already decompressed the socket payload,
   * even though its compressionType field still retains the original value.
   * Comment/gift/like/stats remain exclusively in their existing SDK callbacks.
   *
   * Source: OrdinaryRoad 1.5.8 SCWebFeedPush.proto field 12 / WebShareFeed.proto,
   * and KuaishouCodecHandler / KuaishouBinaryFrameHandler. Neither its watching
   * list nor SC_ENTER_ROOM_ACK is an individual newcomer or follow signal.
   */
  static List<ObjectNode> decode(Object message) throws IOException {
    if (!(message instanceof KuaishouCmdMsg cmd) || cmd.getMsg() == null
        || cmd.getMsg().getPayloadType() != PayloadType.SC_FEED_PUSH) return List.of();
    var payload = cmd.getMsg().getPayload();
    if (payload.size() > MAX_PAYLOAD_BYTES) throw new IOException("Kuaishou feed payload exceeds limit");
    SCWebFeedPush feed = SCWebFeedPush.parseFrom(payload);
    if (feed.getShareFeedsCount() > MAX_SHARES) throw new IOException("Kuaishou share batch exceeds limit");
    List<ObjectNode> result = new ArrayList<>(feed.getShareFeedsCount());
    for (WebShareFeed share : feed.getShareFeedsList()) {
      if (!share.hasUser()) continue;
      var user = share.getUser();
      String uid = user.getPrincipalId(), name = user.getUserName();
      if (uid.isBlank() && name.isBlank()) continue;
      String sourceId = share.getId();
      if (sourceId.isBlank() || sourceId.length() > 4096)
        sourceId = "sha256:" + digest(share.toByteArray());
      sourceId = "kuaishou-share:" + sourceId;
      ObjectNode event = JSON.createObjectNode().put("event_type", "share")
        .put("source_msg_id", sourceId).put("event_id", sourceId)
        .put("user_id", uid).put("user_name", name).put("count", 1);
      // Shares bypass Collector.normalizeEvent, so retain the same raw identity
      // protection before the host considers its shared profile-avatar cache.
      if (Collector.kuaishouIdentityHidden(user, uid)) event.put("user_identity_hidden", true);
      if (!user.getHeadUrl().isBlank() && user.getHeadUrl().length() <= 4096)
        event.put("avatar_url", user.getHeadUrl());
      result.add(event);
    }
    return result;
  }

  /** SDK stats replace absent/invalid feed counters with 0; retain only values actually sent. */
  static ObjectNode snapshot(Object message) throws IOException {
    if (!(message instanceof KuaishouCmdMsg cmd) || cmd.getMsg() == null) return null;
    PayloadType type = cmd.getMsg().getPayloadType();
    if (type != PayloadType.SC_FEED_PUSH && type != PayloadType.SC_LIVE_WATCHING_LIST) return null;
    var payload = cmd.getMsg().getPayload();
    if (payload.size() > MAX_PAYLOAD_BYTES) throw new IOException("Kuaishou feed payload exceeds limit");
    ObjectNode event = JSON.createObjectNode().put("event_type", "room_stats");
    if (type == PayloadType.SC_LIVE_WATCHING_LIST) {
      // The 340 protocol supplies its own displayWatchingCount (field 2).
      // A partial list's length and pendingDuration do not prove audience size.
      var list = SCWebLiveWatchingUsers.parseFrom(payload);
      counter(event, "watching_count", list.getDisplayWatchingCount());
    } else {
      SCWebFeedPush feed = SCWebFeedPush.parseFrom(payload);
      counter(event, "watching_count", feed.getDisplayWatchingCount());
      counter(event, "liked_count", feed.getDisplayLikeCount());
    }
    return event.size() > 1 ? event : null;
  }

  private static void counter(ObjectNode event, String key, String value) {
    // Rounded display text (e.g. 1.2万) cannot prove an exact count. A literal
    // zero is valid, while protobuf's absent empty string means unknown.
    if (value != null && value.matches("[0-9]{1,15}")) {
      long count = Long.parseLong(value);
      if (count <= 1_000_000_000_000L) event.put(key, count);
    }
  }

  private static String digest(byte[] value) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
    catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
  }
}
