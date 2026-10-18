package local.furryup;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.MessageMsg;

/**
 * Web-command adapters for membership purchases, entry effects and SC removal.
 * Membership/V2-toast/SC fields: xfgryujk/blivedm, revision
 * 3bf17fe862b8c2fc6bc04c81c3f0c5db95de93d6, blivedm/models/web.py (MIT).
 * Legacy toast and both entry shapes: bilibili-API-collect preserved in
 * alittlehuaji/bilibili-api-collect-mirror at cfc5fddcc8a94b74d91970bb5b4eaeb349addc47,
 * docs/live/message_stream.md. This class locally implements the documented fields.
 */
final class BilibiliExtraEvents {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int MAX_COUNT = 1_000_000;
  private static final int MAX_IDS = 128;

  static boolean supports(String command) {
    return switch (command(command)) {
      case "GUARD_BUY", "USER_TOAST_MSG", "USER_TOAST_MSG_V2", "ENTRY_EFFECT",
           "ENTRY_EFFECT_MUST_RECEIVE", "SUPER_CHAT_MESSAGE_DELETE" -> true;
      default -> false;
    };
  }

  /** Returns normalized event fields; Collector supplies platform/room/source/receive time. */
  static List<ObjectNode> decode(MessageMsg wire) throws IOException {
    if (wire == null || !supports(wire.getCmd())) return List.of();
    JsonNode data = wire.getData();
    if (data == null || !data.isObject()) throw new IOException("Missing Bilibili event data");
    return switch (command(wire.getCmd())) {
      case "GUARD_BUY", "USER_TOAST_MSG", "USER_TOAST_MSG_V2" -> membership(wire, data);
      case "ENTRY_EFFECT", "ENTRY_EFFECT_MUST_RECEIVE" -> entry(wire, data);
      case "SUPER_CHAT_MESSAGE_DELETE" -> deletion(data);
      default -> List.of();
    };
  }

  private static List<ObjectNode> membership(MessageMsg wire, JsonNode data) throws IOException {
    boolean toastV2 = command(wire.getCmd()).equals("USER_TOAST_MSG_V2");
    JsonNode sender = toastV2 ? data.path("sender_uinfo") : data;
    JsonNode guard = toastV2 ? data.path("guard_info") : data;
    JsonNode pay = toastV2 ? data.path("pay_info") : data;
    JsonNode option = toastV2 ? data.path("option") : data;
    // blivedm documents a second source=2 toast for the same purchase; the platform
    // itself omits it from comments. It must not become another paid gift/thank-you.
    if (command(wire.getCmd()).startsWith("USER_TOAST_MSG") && integer(option.path("source"), -1) == 2)
      return List.of();
    String uid = positiveId(sender.path("uid"));
    int level = integer(guard.path("guard_level"), 0);
    int count = integer(pay.path("num"), 0);
    String started = positiveId(guard.path("start_time"));
    if (uid.isEmpty() || started.isEmpty() || level < 1 || level > 3 || count <= 0 || count > MAX_COUNT)
      throw new IOException("Invalid Bilibili membership identity or quantity");
    // GUARD_BUY and both toast generations mirror one transaction. Their shared
    // identity makes the host's existing event deduplication cover replay and
    // overlapping commands regardless of their optional fields/actual gift ID.
    String id = "bili-guard:" + uid + ":" + level + ":" + started;
    ObjectNode event = base("gift", id).put("user_id", uid)
      .put("gift_id", "guard-" + level).put("gift_name", guardName(level))
      .put("gift_count", count).put("count_mode", "delta").put("gift_kind", "membership")
      .putNull("value");
    optional(event, "user_name", toastV2 ? sender.path("base").path("name") : data.path("username"));
    optional(event, "avatar_url", toastV2 ? sender.path("base").path("face") : data.path("face"));
    // Preserve explicitly sent quantities and units; do not infer months from
    // trial-day labels or calculate a monetary value from platform prices.
    optional(event, "gift_unit", pay.path("unit"));
    long price = positiveLong(pay.path("price"));
    if (price > 0) event.put("gift_price_raw", price).put("gift_price_unit", "bilibili_coin");
    // The legacy documentation does not establish op_type meanings. Keep both
    // purchases and renewals as membership gifts without inventing an action.
    return List.of(event);
  }

  private static List<ObjectNode> entry(MessageMsg wire, JsonNode data) throws IOException {
    JsonNode user = data.path("uinfo"), base = user.path("base");
    String uid = positiveId(data.path("uid"));
    if (uid.isEmpty()) uid = positiveId(user.path("uid"));
    String content = boundedText(data.path("copy_writing"));
    if (content.isEmpty()) content = boundedText(data.path("copy_writing_v2"));
    if (uid.isEmpty() && content.isEmpty()) throw new IOException("Invalid Bilibili entry effect");
    String triggered = positiveId(data.path("trigger_time"));
    // data.id is an effect/catalog ID, not an event ID. Never deduplicate all
    // viewers who happen to have the same entry effect.
    String id = !uid.isEmpty() && !triggered.isEmpty() ? "bili-entry:" + uid + ":" + triggered
      : wire.getId() != null && wire.getId() > 0 ? "bili-entry-wire:" + wire.getId() : "";
    ObjectNode event = base("entry_effect", id);
    if (!uid.isEmpty()) event.put("user_id", uid);
    if (!content.isEmpty()) event.put("content", content.replace("<%", "").replace("%>", ""));
    String name = boundedText(base.path("name"));
    if (name.isEmpty()) name = boundedText(data.path("uname"));
    // Older entry effects send their username only inside the documented <%...%> marker.
    if (name.isEmpty()) {
      int from = content.indexOf("<%"), to = from < 0 ? -1 : content.indexOf("%>", from + 2);
      if (to > from + 2) name = content.substring(from + 2, to);
    }
    if (!name.isEmpty()) event.put("user_name", name);
    String face = boundedText(data.path("face"));
    if (face.isEmpty()) face = boundedText(base.path("face"));
    if (!face.isEmpty()) event.put("avatar_url", face);
    return List.of(event);
  }

  private static List<ObjectNode> deletion(JsonNode data) throws IOException {
    JsonNode ids = data.path("ids");
    if (!ids.isArray() || ids.size() > MAX_IDS) throw new IOException("Invalid Bilibili SC removal list");
    Set<String> actualIds = new LinkedHashSet<>();
    for (JsonNode id : ids) {
      String actual = positiveId(id);
      if (!actual.isEmpty()) actualIds.add(actual);
    }
    if (actualIds.isEmpty()) return List.of();
    ObjectNode event = base("super_chat_delete", "bili-super-chat-delete:" + digest(String.join(",", actualIds)));
    var result = event.putArray("super_chat_ids");
    actualIds.forEach(result::add);
    return List.of(event);
  }

  private static String command(String command) {
    return command == null ? "" : command.split(":", 2)[0];
  }
  private static ObjectNode base(String type, String id) {
    return JSON.createObjectNode().put("event_type", type).put("source_msg_id", id)
      .put("event_id", id.isEmpty() ? UUID.randomUUID().toString() : id);
  }
  private static String guardName(int level) {
    return switch (level) { case 1 -> "总督"; case 2 -> "提督"; case 3 -> "舰长"; default -> ""; };
  }
  private static String boundedText(JsonNode value) {
    if (!value.isTextual()) return "";
    String text = value.asText();
    return text.isBlank() || text.length() > 4096 ? "" : text;
  }
  private static void optional(ObjectNode target, String key, JsonNode value) {
    String text = boundedText(value);
    if (!text.isEmpty()) target.put(key, text);
  }
  private static String positiveId(JsonNode value) {
    if (!value.isIntegralNumber() && !value.isTextual()) return "";
    String text = value.asText();
    if (!text.matches("[0-9]{1,20}")) return "";
    BigInteger id = new BigInteger(text);
    return id.signum() > 0 ? id.toString() : "";
  }
  private static long positiveLong(JsonNode value) {
    String text = positiveId(value);
    if (text.isEmpty()) return 0;
    try { return Long.parseLong(text); } catch (NumberFormatException ignored) { return 0; }
  }
  private static int integer(JsonNode value, int fallback) {
    long number = positiveLong(value);
    return number > 0 && number <= Integer.MAX_VALUE ? (int) number : fallback;
  }
  private static String digest(String value) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
  }
}
