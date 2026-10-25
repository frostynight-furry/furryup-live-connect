package local.furryup;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.DanmuMsgMsg;
import java.util.Locale;
import java.util.regex.Pattern;
import com.google.protobuf.ByteString;
import com.google.protobuf.UnknownFieldSet;

/** Message-local display metadata only; never grants permissions or caches identities. */
final class UserBadges {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static Object get(Object value, String method) {
    try { return value == null ? null : value.getClass().getMethod(method).invoke(value); }
    catch (ReflectiveOperationException | RuntimeException ignored) { return null; }
  }
  private static String text(Object value) { return value instanceof String s ? s : ""; }
  private static long number(Object value) { return value instanceof Number n ? n.longValue() : 0; }
  private static void add(ArrayNode out, String kind, String label, long level) {
    label = label.replaceAll("[\\p{Cntrl}]", " ").trim();
    if (label.isEmpty() || out.size() >= 16) return;
    if (label.length() > 64) label = label.substring(0, 64);
    ObjectNode badge = JSON.createObjectNode().put("kind", kind).put("label", label);
    if (level > 0 && level <= 1000) badge.put("level", level);
    for (JsonNode previous : out) if (previous.equals(badge)) return;
    out.add(badge);
  }
  private static void level(ArrayNode out, String kind, String label, Object value) {
    long n = number(value); if (n > 0 && n <= 1000) add(out, kind, label, n);
  }
  private static boolean hasKind(ArrayNode out, String kind) {
    for (JsonNode badge : out) if (kind.equals(badge.path("kind").asText())) return true;
    return false;
  }
  private static boolean douyinSemanticBadge(ArrayNode out, String label, long contentLevel) {
    // Image alternative text describes existing semantic badges, not extra titles.
    if (label.matches("(?:房管|管理员)(?:勋章|徽章)?")) {
      add(out, "role", "管理员", 0); return true;
    }
    var match = Pattern.compile("^(荣誉|荣耀|粉丝团)等级(?:([0-9]{1,9})级)?(?:勋章|徽章)?$").matcher(label);
    if (!match.matches()) return false;
    String kind = match.group(1).equals("粉丝团") ? "fans" : "wealth";
    long n = match.group(2) == null ? contentLevel : Long.parseLong(match.group(2));
    if (!hasKind(out, kind)) level(out, kind, kind.equals("fans") ? "粉丝团" : "荣誉", n);
    return true;
  }
  private static String wireText(UnknownFieldSet fields, int id) {
    var values = fields.getField(id).getLengthDelimitedList();
    if (values.isEmpty() || values.get(0).size() > 1024 || !values.get(0).isValidUtf8()) return "";
    return values.get(0).toStringUtf8();
  }
  private static void kuaishouSegments(ArrayNode out, Object state, long intimacy) {
    // OrdinaryRoad preserves newer protobuf fields. Decode only the documented
    // state -> segment -> icon path, never arbitrary nested strings or images.
    Object encoded = get(state, "toByteArray");
    if (!(encoded instanceof byte[] bytes) || bytes.length > 262144) return;
    try {
      var fields = UnknownFieldSet.parseFrom(bytes);
      var segments = fields.getField(15).getLengthDelimitedList(); // author view
      if (segments.isEmpty()) segments = fields.getField(11).getLengthDelimitedList();
      int count = 0;
      for (ByteString segmentBytes : segments) {
        if (++count > 64) break;
        if (segmentBytes.size() > 16384) continue;
        try {
          var segment = UnknownFieldSet.parseFrom(segmentBytes);
          String type = wireText(segment, 3);
          var icons = segment.getField(1).getLengthDelimitedList();
          if (icons.isEmpty()) continue;
          var icon = UnknownFieldSet.parseFrom(icons.get(0));
          String path = wireText(icon, 2), label = wireText(icon, 4).trim();
          boolean fans = type.equals("fansGroup") || (type.isEmpty() && path.toLowerCase(Locale.ROOT).startsWith("fans"));
          if (fans) {
            String tier = "";
            if (path.matches("super_fans_vip_v_v2/super_fans_vip_[0-9]{1,3}\\.9\\.png")) tier = "金粉团";
            if (path.matches("super_fans_vip_v_nian_v2/super_fans_vip_[0-9]{1,3}\\.9\\.png")) tier = "金粉团 · 年费";
            if (path.matches("super_fans_svip_v_zuan_v2/super_fans_svip_[0-9]{1,3}\\.9\\.png")) tier = "钻粉团";
            if (path.matches("super_fans_svip_v_nian_zuan_v2/super_fans_svip_[0-9]{1,3}\\.9\\.png")) tier = "钻粉团 · 年费";
            if (!tier.isEmpty()) label = label.isEmpty() ? tier : tier + " · " + label;
            if (label.isEmpty()) label = "粉丝团";
            if (!hasKind(out, "fans")) add(out, "fans", label, intimacy);
          } else if (type.equals("liveRoomVipState") && path.equals("super_guardian_level_label/zhong_ai.png")) {
            add(out, "membership", "钟爱守护", 0);
          } else if (type.equals("honoredGuestState") && path.equals("keyusers/key_user_honoured_guest.png")) {
            add(out, "membership", "贵宾", 0);
          } else if (type.equals("primeAudience") && path.equals("prime_audience.png")) {
            add(out, "title", "核心观众", 0);
          } else if (type.equals("audienceRank") && path.matches("rank_top/rank_top_(?:[1-9]|10)\\.png")) {
            add(out, "title", "榜" + path.substring("rank_top/rank_top_".length(), path.length() - 4), 0);
          } else if (!type.equals("assistantState") && !type.equals("wealthGrade")) {
            add(out, "title", label, 0);
          }
        } catch (java.io.IOException ignored) { /* A malformed optional badge cannot hide siblings. */ }
      }
    } catch (java.io.IOException ignored) { /* Preserve the ordinary typed state fields. */ }
  }
  static ArrayNode extract(String platform, Object message, ObjectNode event) {
    ArrayNode out = JSON.createArrayNode();
    try {
      if (platform.equals("bilibili")) {
        if (message instanceof DanmuMsgMsg msg && msg.getInfo() != null) {
          JsonNode info = msg.getInfo();
          if (info.path(2).path(2).asInt() == 1) add(out, "role", "房管", 0);
          int guard = info.path(7).asInt();
          if (guard >= 1 && guard <= 3) add(out, "membership", new String[]{"", "总督", "提督", "舰长"}[guard], 0);
          add(out, "fans", info.path(3).path(1).asText(""), info.path(3).path(0).asLong());
          level(out, "level", "等级", info.path(4).path(0).isIntegralNumber() ? info.path(4).path(0).asLong() : 0);
          level(out, "wealth", "荣耀", info.path(16).path(0).isIntegralNumber() ? info.path(16).path(0).asLong() : 0);
        } else {
          Object data = get(message, "getData"), user = get(data, "getUser_info");
          long guard = number(get(data, "getGuard_level"));
          if (guard == 0) guard = number(get(user, "getGuard_level"));
          if (guard >= 1 && guard <= 3) add(out, "membership", new String[]{"", "总督", "提督", "舰长"}[(int)guard], 0);
          if (number(get(user, "getManager")) == 1) add(out, "role", "房管", 0);
          level(out, "level", "等级", get(user, "getUser_level"));
        }
      } else if (platform.equals("douyin")) {
        Object user = get(get(message, "getMsg"), "getUser");
        Object fans = get(get(user, "getFansClub"), "getData");
        add(out, "fans", text(get(fans, "getClubName")), number(get(fans, "getLevel")));
        level(out, "wealth", "荣誉", get(get(user, "getPayGrade"), "getLevel"));
        level(out, "level", "等级", get(user, "getLevel"));
        Object badges = get(user, "getBadgeImageListList");
        if (badges instanceof Iterable<?> items) for (Object item : items) {
          Object content = get(item, "getContent");
          String label = text(get(content, "getAlternativeText"));
          if (label.isBlank()) label = text(get(content, "getName"));
          label = label.trim();
          if (douyinSemanticBadge(out, label, number(get(content, "getLevel")))) continue;
          // Only explicit accessible labels: image URLs and internal IDs are not titles.
          add(out, "title", label, number(get(content, "getLevel")));
        }
      } else if (platform.equals("kuaishou")) {
        Object wire = get(message, "getMsg"), state = get(wire, "getSenderState");
        if (state == null) state = get(wire, "getLiveAudienceState");
        long role = number(get(state, "getAssistantTypeValue"));
        if (role == 0) role = number(get(wire, "getLiveAssistantTypeValue"));
        if (role == 1 || role == 2) add(out, "role", role == 1 ? "超管" : "房管", 0);
        level(out, "wealth", "财富", get(state, "getWealthGrade"));
        long intimacy = number(get(get(state, "getLiveFansGroupState"), "getIntimacyLevel"));
        if (intimacy == 0) intimacy = number(get(state, "getFansGroupIntimacyLevel"));
        kuaishouSegments(out, state, intimacy);
        if (!hasKind(out, "fans")) level(out, "fans", "粉丝团", intimacy);
        add(out, "title", text(get(get(state, "getNameplate"), "getName")), 0);
      }
    } catch (RuntimeException ignored) { /* Optional metadata cannot drop a message. */ }
    if (!platform.equals("kuaishou")) {
      boolean hasFans = false;
      for (JsonNode badge : out) if (badge.path("kind").asText().equals("fans")) hasFans = true;
      if (!hasFans) add(out, "fans", event.path("badge_name").asText(""), event.path("badge_level").asLong());
    }
    return out;
  }
}
