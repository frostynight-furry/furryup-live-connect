package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.DouyinCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.RoomUserSeqMessage;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.PayloadTypeOuterClass.PayloadType;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCWebLiveWatchingUsersOuterClass.SCWebLiveWatchingUsers;

/** Bounded viewer snapshots from existing read-only socket connections. */
final class ViewerSnapshots {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int MAX_PAYLOAD_BYTES = 512 * 1024;
  private static final int MAX_VIEWERS = 500;
  private static final int MAX_LEVEL = 1000;
  private static final String RUN_ID = UUID.randomUUID().toString();
  private static final AtomicLong REVISION = new AtomicLong();

  private ViewerSnapshots() {}

  /** Call only from the raw onMsg callback, once per decoded socket frame. */
  static ObjectNode decode(Object message) throws IOException {
    if (message instanceof KuaishouCmdMsg command && command.getMsg() != null
        && command.getMsg().getPayloadType() == PayloadType.SC_LIVE_WATCHING_LIST)
      return kuaishou(command);
    if (message instanceof DouyinCmdMsg command && command.getMsg() != null
        && "WebcastRoomUserSeqMessage".equals(command.getMsg().getMethod()))
      return douyin(command);
    return null;
  }

  private static ObjectNode snapshot(String source, String evidence) {
    ObjectNode result = JSON.createObjectNode().put("source", source)
      .put("presenceEvidence", evidence).put("complete", false);
    result.putArray("viewers");
    return result;
  }

  private static ObjectNode event(String platform, ObjectNode snapshot) {
    long revision = REVISION.incrementAndGet();
    snapshot.put("revision", revision);
    // Identical lists received again are fresh observations. A new process ID
    // avoids collisions after reconnect, without retaining credentials/packets.
    String sourceId = platform + "-viewers:" + RUN_ID + ":" + revision;
    return JSON.createObjectNode().put("event_type", "viewer_snapshot")
      .put("source_msg_id", sourceId).put("event_id", sourceId).set("viewer_snapshot", snapshot);
  }

  private static ObjectNode kuaishou(KuaishouCmdMsg command) throws IOException {
    var payload = command.getMsg().getPayload();
    if (payload.size() > MAX_PAYLOAD_BYTES) throw new IOException("Viewer snapshot exceeds payload limit");
    var list = SCWebLiveWatchingUsers.parseFrom(payload);
    if (list.getWatchingUserCount() > MAX_VIEWERS) throw new IOException("Viewer snapshot exceeds user limit");
    // Evidence is the explicit SC_LIVE_WATCHING_LIST (340) protocol message,
    // not a feed, enter-room acknowledgement, gift ranking or viewer count.
    // Its offline flag identifies entries retained after leaving. Coverage is
    // partial: disappearing, stale or failed observations must break dwell.
    ObjectNode snapshot = snapshot("kuaishou-live-watching-list", "online-list");
    Set<String> ids = new HashSet<>();
    for (var item : list.getWatchingUserList()) {
      if (!item.hasUser()) continue;
      var user = item.getUser();
      String id = user.getPrincipalId();
      if (!validId(id)) continue;
      if (!ids.add(id)) throw new IOException("Duplicate viewer identity");
      var viewer = snapshot.withArray("viewers").addObject()
        .put("userId", id).put("userName", boundedName(user.getUserName()))
        .put("online", !item.getOffline()).put("highWealth", item.getTuhao());
      // tuhao is a platform flag, not a numerical wealth/user level.
      // displayKsCoin is display text and never becomes a wealth level.
      viewer.putNull("userLevel").putNull("wealthLevel");
    }
    return event("kuaishou", snapshot);
  }

  private static ObjectNode douyin(DouyinCmdMsg command) throws IOException {
    var payload = command.getMsg().getPayload();
    if (payload.size() > MAX_PAYLOAD_BYTES) throw new IOException("Viewer snapshot exceeds payload limit");
    var list = RoomUserSeqMessage.parseFrom(payload);
    if (list.getRanksListCount() > MAX_VIEWERS) throw new IOException("Viewer snapshot exceeds user limit");
    // ranksList contains contributors. It provides real user/rank/grade data,
    // but does not by itself prove each contributor is currently watching.
    ObjectNode snapshot = snapshot("douyin-contributor-rank", "unknown");
    Set<String> ids = new HashSet<>();
    for (var item : list.getRanksListList()) {
      if (!item.hasUser() || item.getIsHidden()) continue;
      var user = item.getUser();
      String id = user.getIdStr();
      if (id.isBlank() && user.getId() != 0) id = Long.toUnsignedString(user.getId());
      if (!validId(id)) continue;
      if (!ids.add(id)) throw new IOException("Duplicate viewer identity");
      var viewer = snapshot.withArray("viewers").addObject()
        .put("userId", id).put("userName", boundedName(user.getNickName()));
      viewer.putNull("online").putNull("userLevel").putNull("wealthLevel");
      // User.Level (field 6) and PayGrade.level (field 6) are distinct fields
      // in OrdinaryRoad's bundled douyin.proto; absent grades stay unknown.
      if (user.getLevel() > 0 && user.getLevel() <= MAX_LEVEL)
        viewer.put("userLevel", user.getLevel());
      if (user.hasPayGrade() && user.getPayGrade().getLevel() >= 0
          && user.getPayGrade().getLevel() <= MAX_LEVEL)
        viewer.put("wealthLevel", user.getPayGrade().getLevel());
      if (item.getRank() > 0 && item.getRank() <= MAX_VIEWERS) viewer.put("rank", item.getRank());
    }
    return event("douyin", snapshot);
  }

  private static boolean validId(String value) {
    return value != null && !value.isBlank() && !"0".equals(value) && value.length() <= 128
      && value.chars().noneMatch(character -> character < 32 || character == 127);
  }

  private static String boundedName(String value) {
    if (value == null) return "";
    String cleaned = value.replaceAll("[\\p{Cntrl}]", " ").strip();
    return cleaned.substring(0, Math.min(64, cleaned.length()));
  }
}
