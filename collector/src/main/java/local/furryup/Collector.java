package local.furryup;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import tech.ordinaryroad.live.chat.client.commons.base.msg.*;
import tech.ordinaryroad.live.chat.client.bilibili.client.BilibiliLiveChatClient;
import tech.ordinaryroad.live.chat.client.bilibili.config.BilibiliLiveChatClientConfig;
import tech.ordinaryroad.live.chat.client.bilibili.listener.IBilibiliMsgListener;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.MessageMsg;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.SendGiftMsg;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.InteractWordMsg;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.SuperChatMessageMsg;
import tech.ordinaryroad.live.chat.client.codec.bilibili.room.BilibiliRoomInitResult;
import tech.ordinaryroad.live.chat.client.douyin.client.DouyinLiveChatClient;
import tech.ordinaryroad.live.chat.client.douyin.config.DouyinLiveChatClientConfig;
import tech.ordinaryroad.live.chat.client.douyin.listener.IDouyinMsgListener;
import tech.ordinaryroad.live.chat.client.codec.douyin.constant.DouyinRoomStatusEnum;
import tech.ordinaryroad.live.chat.client.codec.douyin.room.DouyinRoomInitResult;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.DouyinGiftMsg;
import tech.ordinaryroad.live.chat.client.kuaishou.client.KuaishouLiveChatClient;
import tech.ordinaryroad.live.chat.client.kuaishou.config.KuaishouLiveChatClientConfig;
import tech.ordinaryroad.live.chat.client.kuaishou.listener.IKuaishouMsgListener;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.constant.RoomInfoGetTypeEnum;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.room.KuaishouRoomInitResult;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouGiftMsg;
import tech.ordinaryroad.live.chat.client.commons.base.constant.LiveStatusAction;
import tech.ordinaryroad.live.chat.client.commons.base.constant.RoomLiveStatusEnum;
import tech.ordinaryroad.live.chat.client.commons.base.constant.SocialActionEnum;

/** Read-only platform collector. Configuration travels through stdin, never command arguments. */
public final class Collector {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final KuaishouAvatarCache KUAISHOU_AVATARS = new KuaishouAvatarCache();
  // Java 21 keeps stdout.encoding separate from file.encoding on Windows (often GBK).
  // The host reads UTF-8 JSON lines, so encode directly at the process pipe boundary.
  private static final PrintStream OUT = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
  private static String platform;
  private static String room;
  private static String lastRoomStatus = "";
  private static synchronized void emit(ObjectNode message) {
    OUT.println(message.toString());
    OUT.flush();
  }
  private static void status(String state) {
    emit(JSON.createObjectNode().put("kind", "status").put("state", state));
  }
  private static void diagnostic(String metric) {
    emit(JSON.createObjectNode().put("kind", "diagnostic").put("metric", metric));
  }
  private static void failure(Throwable error) {
    ObjectNode result = JSON.createObjectNode().put("kind", "status").put("state", "connect-failed").put("code", ConnectionFailure.classify(error));
    // Exception types and method names aid diagnosis without exposing messages, cookies or response bodies.
    var trace = result.putArray("diagnosticTypes");
    Throwable current = error;
    for (int i = 0; current != null && i < 8; i++, current = current.getCause()) {
      var item = trace.addObject().put("type", current.getClass().getName());
      if (current.getStackTrace().length > 0) {
        var frame = current.getStackTrace()[0];
        item.put("method", frame.getClassName() + "." + frame.getMethodName()).put("line", frame.getLineNumber());
      }
    }
    emit(result);
  }
  private static String text(Object value) { return value == null ? "" : String.valueOf(value); }
  private static void optionalText(ObjectNode target, String key, Object value) {
    String result = text(value);
    if (!result.isBlank() && result.length() <= 4096) target.put(key, result);
  }
  private static Object get(Object value, String name) {
    if (value == null) return null;
    try { return value.getClass().getMethod(name).invoke(value); }
    catch (ReflectiveOperationException ignored) { return null; }
  }
  static boolean kuaishouIdentityHidden(Object user, String userId) {
    if ("OUTSIDE".equals(userId)) return true;
    if (Boolean.TRUE.equals(get(user, "getMystery"))) return true;
    // The official SimpleUserInfo protocol defines mystery as bool field 4.
    // OrdinaryRoad 1.5.8 has no getter for it, but protobuf preserves that field.
    if (user instanceof com.google.protobuf.Message wireUser) {
      for (long value : wireUser.getUnknownFields().getField(4).getVarintList()) {
        if (value != 0) return true;
      }
    }
    return false;
  }
  private static String sourceId(Object msg) {
    if (msg instanceof InteractWordMsg interact && interact.getData() != null) {
      var data = interact.getData();
      if (data.getUid() > 0 && data.getTimestamp() > 0)
        return "bili-interact:" + data.getUid() + ":" + data.getMsg_type() + ":" + data.getTimestamp();
    }
    if (msg instanceof SuperChatMessageMsg sc && sc.getData() != null && sc.getData().getId() > 0)
      return "bili-super-chat:" + sc.getData().getId();
    if (msg instanceof SendGiftMsg gift && gift.getData() != null) {
      String tid = text(gift.getData().getTid());
      if (tid.isBlank()) tid = text(gift.getData().getRnd());
      if (!tid.isBlank()) return "bili-gift:" + tid + ":" + gift.getGiftId();
    }
    Object wire = get(msg, "getMsg");
    Object common = get(wire, "getCommon");
    Object id = get(common, "getMsgId");
    if (id == null) id = get(wire, "getId");
    if (id == null) id = get(get(msg, "getData"), "getTid");
    String result = text(id);
    return result.isBlank() || result.equals("0") ? "" : result;
  }
  private static void badge(ObjectNode e, Object msg) {
    String name = text(get(msg, "getBadgeName"));
    if (name.isBlank() && msg instanceof SuperChatMessageMsg sc && sc.getData() != null
        && sc.getData().getMedal_info() != null) {
      var medal = sc.getData().getMedal_info();
      name = text(medal.getMedal_name());
      if (!name.isBlank()) e.put("badge_level", Byte.toUnsignedInt(medal.getMedal_level()));
    }
    if (name.isBlank()) return;
    optionalText(e, "badge_name", name);
    if (!e.has("badge_level")) {
      Object level = get(msg, "getBadgeLevel");
      if (level instanceof Number number) e.put("badge_level", Byte.toUnsignedInt(number.byteValue()));
    }
  }
  private static void giftDetails(ObjectNode e, IGiftMsg gift, Object msg) {
    String image = "";
    // V2 includes its own material image, independent of room/catalog context.
    // The older SDK getter starts a catalog request, so keep its room guard.
    if (msg instanceof BilibiliGiftV2.SnapshotGift snapshot) {
      image = snapshot.getGiftImg();
    } else if (!(msg instanceof SendGiftMsg bili) || bili.getRoomId() > 0) {
      try { image = text(gift.getGiftImg()); }
      catch (RuntimeException ignored) { /* An absent catalog should not drop a gift. */ }
    }
    optionalText(e, "gift_image_url", image);
    if (msg instanceof SendGiftMsg bili && bili.getData() != null) {
      var data = bili.getData();
      if (data.getPrice() > 0) {
        e.put("gift_price_raw", data.getPrice()).put("gift_price_unit", "bilibili_coin");
      }
      optionalText(e, "gift_coin_type", data.getCoin_type());
      optionalText(e, "combo_id", data.getBatch_combo_id());
    } else if (msg instanceof DouyinGiftMsg douyin && douyin.getMsg() != null) {
      var wire = douyin.getMsg();
      if (wire.hasGift() && wire.getGift().getDiamondCount() > 0)
        e.put("gift_price_raw", wire.getGift().getDiamondCount()).put("gift_price_unit", "diamond");
      if (wire.getGroupId() > 0) e.put("combo_id", Long.toString(wire.getGroupId()));
    } else if (msg instanceof KuaishouGiftMsg kuaishou && kuaishou.getMsg() != null) {
      optionalText(e, "combo_id", kuaishou.getMsg().getMergeKey());
    }
    // Protobuf default users have ID 0 even when no recipient was sent.
    boolean hasRecipient = !(msg instanceof DouyinGiftMsg douyin) || (douyin.getMsg() != null && douyin.getMsg().hasToUser());
    if (hasRecipient) {
      try {
        String uid = text(gift.getReceiveUid());
        if (!uid.equals("0")) optionalText(e, "receive_user_id", uid);
        optionalText(e, "receive_user_name", gift.getReceiveUsername());
      } catch (RuntimeException ignored) { /* Optional recipient data. */ }
    }
  }
  private static String roomLiveStatus(Object status) {
    if (status == RoomLiveStatusEnum.LIVING) return "started";
    if (status == RoomLiveStatusEnum.STOPPED) return "ended";
    return "";
  }
  private static void roomInfo(Object result, String description) {
    ObjectNode info = normalizeRoomInfo(result, description);
    if (info != null) {
      emit(info);
      String liveStatus = info.path("room_live_status").asText("");
      if (!liveStatus.isBlank() && !liveStatus.equals(lastRoomStatus)) {
        lastRoomStatus = liveStatus;
        extraEvent(JSON.createObjectNode().put("event_type", "live_status").put("live_status", liveStatus)
          .put("source_msg_id", "room-status:" + UUID.randomUUID()));
      }
    }
  }
  static ObjectNode normalizeRoomInfo(Object result, String description) {
    if (result == null) return null;
    ObjectNode info = JSON.createObjectNode().put("kind", "room-info");
    optionalText(info, "room_title", get(result, "getRoomTitle"));
    optionalText(info, "room_description", description);
    optionalText(info, "room_live_status", roomLiveStatus(get(result, "getRoomLiveStatus")));
    return info.size() > 1 ? info : null;
  }
  static void event(String callback, Object msg) {
    ObjectNode normalized = normalizeEvent(callback, msg);
    if (normalized != null) emit(JSON.createObjectNode().put("kind", "event").set("event", normalized));
  }
  private static void extraEvent(ObjectNode normalized) {
    normalized.put("schemaVersion", 1).put("platform", platform).put("room_id", room)
      .put("source", "ordinaryroad").put("timestamp", System.currentTimeMillis());
    if (!normalized.hasNonNull("event_id")) normalized.put("event_id", normalized.path("source_msg_id").asText(UUID.randomUUID().toString()));
    if (normalized.path("event_type").asText().equals("gift")) diagnostic("giftCallbacks");
    if (normalized.path("event_type").asText().equals("live_status")) lastRoomStatus = normalized.path("live_status").asText("");
    emit(JSON.createObjectNode().put("kind", "event").set("event", normalized));
  }
  static ObjectNode normalizeEvent(String callback, Object msg) {
    if (msg == null) return null;
    ObjectNode e = JSON.createObjectNode().put("schemaVersion", 1).put("platform", platform)
      .put("room_id", room).put("source", "ordinaryroad").put("timestamp", System.currentTimeMillis());
    String id = sourceId(msg);
    e.put("source_msg_id", id).put("event_id", id.isEmpty() ? UUID.randomUUID().toString() : id);
    if (callback.equals("onGiftMsg") && msg instanceof IGiftMsg gift) {
      diagnostic("giftCallbacks");
      // OrdinaryRoad already converts Douyin/Kuaishou cumulative combos to increments.
      int giftCount = gift.getGiftCount();
      if (giftCount <= 0) { diagnostic("zeroGiftCallbacks"); return null; }
      e.put("event_type", "gift").put("user_id", text(gift.getUid())).put("user_name", text(gift.getUsername()))
        .put("gift_id", text(gift.getGiftId())).put("gift_count", giftCount).put("count_mode", "delta");
      String giftName = "";
      try { giftName = text(gift.getGiftName()); }
      catch (RuntimeException ignored) { /* Keep the event and its ID when the catalog has no name. */ }
      e.put("gift_name", giftName.isBlank() ? "未知礼物（ID：" + text(gift.getGiftId()) + "）" : giftName);
      // Prices have different units across platforms. Never fabricate a cross-platform value.
      e.putNull("value");
      giftDetails(e, gift, msg);
    } else if (callback.equals("onDanmuMsg") && msg instanceof IDanmuMsg chat) {
      e.put("event_type", "comment").put("user_id", text(chat.getUid())).put("user_name", text(chat.getUsername()))
        .put("content", text(chat.getContent()));
    } else if (callback.equals("onLikeMsg") && msg instanceof ILikeMsg like) {
      e.put("event_type", "like").put("user_id", text(like.getUid())).put("user_name", text(like.getUsername()))
        .put("count", like.getClickCount());
    } else if (callback.equals("onEnterRoomMsg") && msg instanceof IEnterRoomMsg enter) {
      String type = "enter";
      if (msg instanceof InteractWordMsg bili) {
        int msgType = bili.getData() == null ? 0 : bili.getData().getMsg_type();
        type = switch (msgType) { case 1 -> "enter"; case 2 -> "follow"; case 3 -> "share"; default -> ""; };
      }
      if (type.isEmpty()) return null;
      e.put("event_type", type).put("user_id", text(enter.getUid())).put("user_name", text(enter.getUsername()));
    } else if (callback.equals("onSocialMsg") && msg instanceof ISocialMsg social) {
      SocialActionEnum action = social.getSocialAction();
      if (action == SocialActionEnum.SUBSCRIBE) e.put("event_type", "follow");
      else if (action == SocialActionEnum.SHARE) e.put("event_type", "share");
      else return null;
      e.put("user_id", text(social.getUid())).put("user_name", text(social.getUsername()));
    } else if (callback.equals("onSuperChatMsg") && msg instanceof ISuperChatMsg sc) {
      e.put("event_type", "super_chat").put("user_id", text(sc.getUid())).put("user_name", text(sc.getUsername()))
        .put("content", text(sc.getContent()));
      if (sc.getDuration() > 0) e.put("super_chat_duration", sc.getDuration());
      if (msg instanceof SuperChatMessageMsg bili && bili.getData() != null && bili.getData().getPrice() > 0)
        e.put("super_chat_price_raw", bili.getData().getPrice()).put("super_chat_price_unit", "cny");
      if (msg instanceof SuperChatMessageMsg bili && bili.getData() != null && bili.getData().getId() > 0)
        e.put("super_chat_id", Long.toString(bili.getData().getId()));
    } else if (callback.equals("onRoomStatsMsg") && msg instanceof IRoomStatsMsg stats) {
      e.put("event_type", "room_stats");
      optionalText(e, "watching_count", stats.getWatchingCount());
      optionalText(e, "watched_count", stats.getWatchedCount());
      optionalText(e, "liked_count", stats.getLikedCount());
      if (!e.has("watching_count") && !e.has("watched_count") && !e.has("liked_count")) return null;
    } else if (callback.equals("onLiveStatusMsg") && msg instanceof ILiveStatusChangeMsg status) {
      LiveStatusAction action = status.getLiveStatusAction();
      if (action == LiveStatusAction.BEGIN) e.put("live_status", "started");
      else if (action == LiveStatusAction.END) e.put("live_status", "ended");
      else return null;
      e.put("event_type", "live_status");
      lastRoomStatus = e.path("live_status").asText();
    } else if (callback.equals("onEntryEffect") && msg instanceof MessageMsg effect && "bilibili".equals(platform)) {
      JsonNode data = effect.getData();
      if (data == null || !data.isObject()) return null;
      e.put("event_type", "entry_effect");
      optionalText(e, "user_id", data.path("uid").asText());
      optionalText(e, "user_name", data.path("uname").asText());
      optionalText(e, "content", data.path("copy_writing").asText());
      if (!e.has("user_id") && !e.has("content")) return null;
    } else return null;
    if (msg instanceof IDanmuMsg) {
      var emotes = MessageEmotes.extract(msg, e.path("content").asText());
      if (!emotes.isEmpty()) e.set("emotes", emotes);
    }
    // Some SDK message variants omit the avatar or throw while decoding it. Keep the message.
    String avatar = text(get(msg, "getUserAvatar"));
    if ("kuaishou".equals(platform)) {
      String userId = e.path("user_id").asText();
      boolean hidden = kuaishouIdentityHidden(get(get(msg, "getMsg"), "getUser"), userId);
      if (hidden) e.put("user_identity_hidden", true);
      // Hidden identities keep only the avatar supplied on this message; do not
      // reveal a previously cached identity or seed avatars for later messages.
      avatar = KUAISHOU_AVATARS.resolve(room, hidden ? "" : userId, avatar);
    }
    if (!avatar.isBlank() && avatar.length() <= 4096) e.put("avatar_url", avatar);
    badge(e, msg);
    var userBadges = UserBadges.extract(platform, msg, e);
    if (!userBadges.isEmpty()) e.set("user_badges", userBadges);
    return e;
  }
  @SuppressWarnings("unchecked")
  static <T> T listener(Class<T> type) {
    return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (proxy, method, args) -> {
      if (method.getDeclaringClass() == Object.class) {
        return switch (method.getName()) {
          case "hashCode" -> System.identityHashCode(proxy);
          case "equals" -> proxy == args[0];
          default -> "FurryUP Studio read-only listener";
        };
      }
      if (args != null && args.length > 0) {
        try {
          Object message = args[args.length - 1];
          boolean otherCommand = method.getName().equals("onOtherCmdMsg") || method.getName().equals("onUnknownCmd");
          String cmd = text(get(message, "getCmd")).split(":", 2)[0];
          if (method.getName().equals("onMsg")) {
            ObjectNode viewers = ViewerSnapshots.decode(message);
            if (viewers != null) extraEvent(viewers);
            ObjectNode pk = PkEvents.decode(message);
            if (pk != null) extraEvent(pk);
          }
          if ("kuaishou".equals(platform) && method.getName().equals("onMsg")) {
            for (ObjectNode extra : KuaishouExtraEvents.decode(message)) extraEvent(extra);
            ObjectNode snapshot = KuaishouExtraEvents.snapshot(message);
            if (snapshot != null) extraEvent(snapshot);
          } else if ("kuaishou".equals(platform) && method.getName().equals("onRoomStatsMsg")) {
            // Raw feed counters above preserve absent fields; the SDK fabricates
            // zero for an empty/invalid field on every comment/gift/share frame.
          } else if ("bilibili".equals(platform) && (otherCommand || method.getName().equals("onEntryEffect"))
              && message instanceof MessageMsg wire && BilibiliExtraEvents.supports(wire.getCmd())) {
            for (ObjectNode extra : BilibiliExtraEvents.decode(wire)) extraEvent(extra);
          } else if ("bilibili".equals(platform) && otherCommand && message instanceof MessageMsg wire
              && "SEND_GIFT_V2".equals(cmd)) {
            for (SendGiftMsg gift : BilibiliGiftV2.decodeData(wire.getData())) event("onGiftMsg", gift);
          } else if ("bilibili".equals(platform) && otherCommand && message instanceof MessageMsg wire
              && "INTERACT_WORD_V2".equals(cmd)) {
            event("onEnterRoomMsg", BilibiliInteractV2.decodeData(wire.getData()));
          } else {
            if (otherCommand) {
              if (cmd.toLowerCase(java.util.Locale.ROOT).contains("gift")) diagnostic("unsupportedGiftCommands");
            }
            event(method.getName(), message);
          }
        }
        catch (RuntimeException | IOException ignored) {
          Object message = args[args.length - 1];
          String failedCmd = text(get(message,"getCmd")).split(":", 2)[0];
          if (method.getName().equals("onGiftMsg") || failedCmd.toLowerCase(java.util.Locale.ROOT).contains("gift")
              || failedCmd.equals("GUARD_BUY") || failedCmd.startsWith("USER_TOAST_MSG")) diagnostic("giftParseErrors");
          status("message-error");
        }
      }
      return null;
    });
  }
  public static void main(String[] args) throws Exception {
    // Suppress third-party logs which may contain cookies or signed URLs.
    System.setOut(new PrintStream(OutputStream.nullOutputStream()));
    System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    if (args.length == 1 && args[0].equals("--self-test")) {
      ConnectionFailure.selfTest();
      MessageEmotes.selfTest();
      Class.forName(BilibiliLiveChatClient.class.getName());
      Class.forName(DouyinLiveChatClient.class.getName());
      Class.forName(KuaishouLiveChatClient.class.getName());
      status("self-test-ok"); return;
    }
    if (args.length == 1 && args[0].equals("--network-self-test")) {
      try (var selector = java.nio.channels.Selector.open()) { status("network-self-test-ok"); }
      catch (Throwable error) { failure(error); System.exit(1); }
      return;
    }
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line = input.readLine();
    if (line == null || line.length() > 32768) return;
    JsonNode config = JSON.readTree(line);
    platform = config.path("platform").asText();
    room = config.path("roomId").asText();
    String cookie = config.path("cookie").asText();
    if (!room.matches("[A-Za-z0-9_-]{1,128}")) { status("invalid-room"); return; }
    try {
      switch (platform) {
        case "bilibili" -> {
          var client = new BilibiliAuthenticatedClient(BilibiliLiveChatClientConfig.builder().roomId(room).cookie(cookie).autoReconnect(false).build(), listener(IBilibiliMsgListener.class)) {
            @Override public BilibiliRoomInitResult initRoom() {
              BilibiliRoomInitResult result = super.initRoom();
              roomInfo(result, "");
              return result;
            }
          };
          Runtime.getRuntime().addShutdownHook(new Thread(client::destroy));
          client.addStatusChangeListener((evt, oldState, newState) -> status(newState.name().toLowerCase()));
          client.connect(null, Collector::failure);
          while (input.readLine() != null) { } client.destroy();
        }
        case "douyin" -> {
          var client = new DouyinAuthenticatedClient(DouyinLiveChatClientConfig.builder().roomId(room).cookie(cookie).autoReconnect(false).build(), listener(IDouyinMsgListener.class)) {
            @Override public DouyinRoomInitResult initRoom() {
              DouyinRoomInitResult result = super.initRoom();
              if (result == null || result.getRealRoomId() <= 0) throw new ConnectionFailure("NO_LIVE_SESSION");
              if (result.getRoomStatus() == DouyinRoomStatusEnum.STOPPED) throw new ConnectionFailure("ROOM_OFFLINE");
              JsonNode info = result.getRoomInfoJsonNode();
              JsonNode description = info == null ? null : info.path("room").path("description");
              roomInfo(result, description == null ? "" : description.asText(""));
              return result;
            }
          };
          Runtime.getRuntime().addShutdownHook(new Thread(client::destroy));
          client.addStatusChangeListener((evt, oldState, newState) -> status(newState.name().toLowerCase()));
          client.connect(null, Collector::failure);
          while (input.readLine() != null) { } client.destroy();
        }
        case "kuaishou" -> {
          // Guest requests use the SDK's guest API, rather than its brittle cookie-page parser.
          // The desktop manager owns the bounded retry budget for all three platforms.
          var client = new KuaishouLiveChatClient(KuaishouLiveChatClientConfig.builder().roomId(room).cookie(cookie)
              .roomInfoGetType(cookie.isBlank() ? RoomInfoGetTypeEnum.NOT_COOKIE : RoomInfoGetTypeEnum.COOKIE)
              .autoReconnect(false).build(), listener(IKuaishouMsgListener.class)) {
            @Override public KuaishouRoomInitResult initRoom() {
              KuaishouRoomInitResult result = super.initRoom();
              if (result == null || result.getLiveStreamId() == null || result.getLiveStreamId().isBlank()
                  || result.getToken() == null || result.getToken().isBlank()
                  || result.getWebsocketUrls() == null || result.getWebsocketUrls().isEmpty()) {
                throw new ConnectionFailure("NO_LIVE_SESSION");
              }
              roomInfo(result, text(get(result, "getRoomDescription")));
              return result;
            }
          };
          Runtime.getRuntime().addShutdownHook(new Thread(client::destroy));
          client.addStatusChangeListener((evt, oldState, newState) -> status(newState.name().toLowerCase()));
          client.connect(null, Collector::failure);
          while (input.readLine() != null) { } client.destroy();
        }
        default -> status("invalid-platform");
      }
    } catch (Throwable error) { failure(error); System.exit(1); }
    System.exit(0);
  }
}
