package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
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
  private static final int MAX_SNAPSHOT_BYTES = 192 * 1024;
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
    // Avatar URLs can dominate an otherwise small protobuf. Bound the actual
    // UTF-8 JSON too, leaving room for the collector envelope under its 256 KiB
    // stdout-line limit. This source is partial regardless of truncation.
    var boundedViewers = JSON.createArrayNode();
    int bytes = 1024;
    for (var viewer : snapshot.withArray("viewers")) {
      int cost = viewer.toString().getBytes(StandardCharsets.UTF_8).length + 1;
      if (bytes + cost > MAX_SNAPSHOT_BYTES) break;
      bytes += cost;
      boundedViewers.add(viewer);
    }
    snapshot.set("viewers", boundedViewers);
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
    Set<String> hiddenIds = new HashSet<>();
    for (var item : list.getWatchingUserList()) {
      if (item.hasUser() && Collector.kuaishouIdentityHidden(item.getUser(), item.getUser().getPrincipalId()))
        hiddenIds.add(item.getUser().getPrincipalId());
    }
    for (var item : list.getWatchingUserList()) {
      if (!item.hasUser()) continue;
      var user = item.getUser();
      String id = user.getPrincipalId();
      if (!validId(id) || hiddenIds.contains(id)) continue;
      if (!ids.add(id)) throw new IOException("Duplicate viewer identity");
      var viewer = snapshot.withArray("viewers").addObject()
        .put("userId", id).put("userName", boundedName(user.getUserName()))
        .put("online", !item.getOffline()).put("highWealth", item.getTuhao());
      // tuhao is a platform flag, not a numerical wealth/user level.
      // displayKsCoin is display text and never becomes a wealth level.
      viewer.putNull("userLevel").putNull("wealthLevel");
      String avatar = avatarUrl(user.getHeadUrl(), "kuaishou");
      if (avatar != null) viewer.put("avatarUrl", avatar);
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
    Set<String> hiddenIds = new HashSet<>();
    for (var item : list.getRanksListList()) {
      if (item.hasUser() && item.getIsHidden()) hiddenIds.add(douyinId(item.getUser()));
    }
    for (var item : list.getRanksListList()) {
      if (!item.hasUser() || item.getIsHidden()) continue;
      var user = item.getUser();
      String id = douyinId(user);
      if (!validId(id) || hiddenIds.contains(id)) continue;
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
      String avatar = null;
      for (var image : java.util.List.of(user.getAvatarThumb(), user.getAvatarMedium(), user.getAvatarLarge())) {
        // Only bounded URL candidates from documented avatar image fields;
        // no requests, profile lookup or identity cache are needed here.
        for (int index = 0; index < Math.min(8, image.getUrlListListCount()); index++) {
          avatar = avatarUrl(image.getUrlListList(index), "douyin");
          if (avatar != null) break;
        }
        if (avatar != null) break;
      }
      if (avatar != null) viewer.put("avatarUrl", avatar);
    }
    return event("douyin", snapshot);
  }

  private static boolean validId(String value) {
    return value != null && !value.isBlank() && value.equals(value.strip()) && value.length() <= 128
      && !Set.of("0", "outside", "unknown", "anonymous", "null", "undefined").contains(value.toLowerCase(Locale.ROOT))
      && value.chars().noneMatch(character -> character < 32 || character == 127);
  }

  private static String douyinId(tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.User user) {
    return user.getIdStr().isBlank() && user.getId() != 0 ? Long.toUnsignedString(user.getId()) : user.getIdStr();
  }

  private static String avatarUrl(String value, String platform) {
    if (value == null || value.isEmpty() || value.length() > 4096
        || value.chars().anyMatch(character -> character <= 32 || character == 127)) return null;
    try {
      URI uri = URI.create(value);
      if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null
          || uri.getPort() != -1 || uri.getHost() == null) return null;
      String host = uri.getHost().toLowerCase(Locale.ROOT);
      String[] suffixes = "kuaishou".equals(platform)
        ? new String[]{"yximgs.com", "kwimgs.com", "kwaicdn.com", "kwai.net", "wskwai.com"}
        : new String[]{"douyinpic.com", "douyincdn.com", "byteimg.com", "ibytedtos.com", "pstatp.com"};
      for (String suffix : suffixes) {
        if (host.equals(suffix) || host.endsWith("." + suffix)) {
          // Fragments are not sent to an image server and must not split IDs.
          return value.split("#", 2)[0];
        }
      }
    } catch (IllegalArgumentException ignored) { }
    return null;
  }

  private static String boundedName(String value) {
    if (value == null) return "";
    String cleaned = value.replaceAll("[\\p{Cntrl}]", " ").strip();
    return cleaned.substring(0, Math.min(64, cleaned.length()));
  }
}
