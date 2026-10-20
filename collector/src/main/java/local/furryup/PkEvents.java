package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.protobuf.ByteString;
import com.google.protobuf.CodedInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Set;
import java.net.URI;
import java.util.Locale;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.MessageMsg;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.DouyinCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouCmdMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.PayloadTypeOuterClass.PayloadType;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCLiveMultiPkStatisticOuterClass.SCLiveMultiPkStatistic;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SCWebPipEndedOuterClass.SCWebPipEnded;

/** PK evidence from the existing read-only socket. No comment-text inference. */
final class PkEvents {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int LIMIT = 512 * 1024;
  private static final long EARLIEST_EPOCH = 946684800000L;
  private static final long LATEST_EPOCH = 4102444800000L;
  private static final Set<String> START = Set.of("WebcastLinkMicBattleMethod", "WebcastLinkmicBattleMethod");
  private static final Set<String> END = Set.of("WebcastLinkMicBattleFinishMethod", "WebcastLinkmicBattleFinishMethod");
  private static final Set<String> REFRESH = Set.of("WebcastLinkMicArmiesMethod", "WebcastLinkmicArmiesMethod");
  private static final Set<String> BILI_PRE = Set.of("PK_BATTLE_PRE", "PK_BATTLE_PRE_NEW");
  private static final Set<String> BILI_START = Set.of("PK_BATTLE_START", "PK_BATTLE_START_NEW");
  private static final Set<String> BILI_PROGRESS = Set.of("PK_BATTLE_PROCESS", "PK_BATTLE_PROCESS_NEW");

  private PkEvents() {}

  static ObjectNode decode(Object message) throws IOException { return decode(message, System.currentTimeMillis()); }

  static ObjectNode decode(Object message, long receivedAt) throws IOException {
    if (message instanceof MessageMsg command) return bilibili(command, receivedAt);
    if (message instanceof KuaishouCmdMsg command && command.getMsg() != null) {
      var wire = command.getMsg();
      if (wire.getPayloadType() == PayloadType.SC_PK_STATISTIC) {
        checkSize(wire.getPayload());
        var value = SCLiveMultiPkStatistic.parseFrom(wire.getPayload());
        if (!validId(value.getPkId())) return null;
        ObjectNode pk = base(value.getPkId(), "active", "SC_PK_STATISTIC", receivedAt);
        if (!sourceTime(pk, value.getTime(), receivedAt)) return null;
        pk.put("revision", Long.toUnsignedString(value.getStatisticVersion()));
        return event(pk, "kuaishou-pk:" + digest(wire.getPayload()));
      }
      if (wire.getPayloadType() == PayloadType.SC_PIP_ENDED) {
        checkSize(wire.getPayload());
        var value = SCWebPipEnded.parseFrom(wire.getPayload());
        ObjectNode pk = base(null, "ended", "SC_PIP_ENDED", receivedAt).put("reason", "link-ended");
        if (!sourceTime(pk, value.getTime(), receivedAt)) return null;
        return event(pk, "kuaishou-pk-link-end:" + digest(wire.getPayload()));
      }
    }
    if (message instanceof DouyinCmdMsg command && command.getMsg() != null) {
      String method = command.getMsg().getMethod();
      if (DouyinPkScores.supports(method)) return DouyinPkScores.decode(command, receivedAt);
      if (!START.contains(method) && !END.contains(method) && !REFRESH.contains(method)) return null;
      ByteString payload = command.getMsg().getPayload();
      checkSize(payload);
      ByteString common = null, settings = null;
      boolean armies = false;
      var input = payload.newCodedInput();
      input.setRecursionLimit(8);
      for (int n = 0, tag; (tag = input.readTag()) != 0; n++) {
        if (n >= 2048) throw new IOException("PK field limit");
        if (tag == 10) {
          if (common != null) throw new IOException("Duplicate PK common");
          common = input.readBytes();
        } else if ((tag == 18 || tag == 26) && REFRESH.contains(method)) {
          armies |= !input.readBytes().isEmpty();
        } else if (tag == 18) {
          if (settings != null) throw new IOException("Duplicate PK settings");
          settings = input.readBytes();
        } else if (!input.skipField(tag)) throw new IOException("Invalid PK wire field");
      }
      if (common == null || common.isEmpty()) return null;
      // Only these schema fields are read. Unrelated profile data is not retained.
      var header = numbers(common, Set.of(2, 3, 4));
      var values = settings == null ? java.util.Map.<Integer, Long>of() : numbers(settings, Set.of(2, 3, 4));
      Long battleId = values.get(2);
      if (!REFRESH.contains(method) && (battleId == null || battleId == 0)) return null;
      if (REFRESH.contains(method) && !armies) return null;
      ObjectNode pk = base(battleId == null ? null : Long.toUnsignedString(battleId), END.contains(method) ? "ended" : "active", method, receivedAt);
      if (END.contains(method)) pk.put("reason", "battle-finished");
      if (END.contains(method)) {
        var participants = DouyinPkScores.finish(payload);
        if (!participants.isEmpty()) pk.set("participants", participants);
      }
      if (REFRESH.contains(method)) pk.put("reason", "battle-refresh");
      if (!sourceTime(pk, header.getOrDefault(4, 0L), receivedAt)) return null;
      Long startedAt = values.get(3), duration = values.get(4);
      if (startedAt != null && startedAt >= EARLIEST_EPOCH && startedAt <= LATEST_EPOCH) {
        pk.put("startedAt", startedAt);
        // The im.BattleSettings schema and public captured finish packet agree:
        // start_time_ms is epoch ms; duration=300 precedes punish_start by 300s.
        if (duration != null && duration > 0 && duration <= 3600) {
          long endsAt = startedAt + duration * 1000;
          pk.put("endsAt", endsAt);
          if (startedAt > receivedAt + 30_000 || endsAt < receivedAt - 90_000) return null;
        } else if (startedAt > receivedAt + 30_000 || startedAt < receivedAt - 3_600_000) return null;
      }
      Long messageId = header.get(2);
      String id = messageId != null && messageId != 0 ? Long.toUnsignedString(messageId) : digest(payload);
      return event(pk, "douyin-pk:" + method + ":" + id);
    }
    return null;
  }

  /**
   * Original adapter for the JSON wire fields documented in:
   * qydysky/bili_danmu 76304fa1c5e337d20837a2b346a3c2a90c680996,
   * Reply/ws_msg/PK_BATTLE_{PRE,START,PROCESS}_NEW.go (MIT); and
   * ShmilyChen/bilive_client c0d70369ef5b3128309201ffb0f65522b31d5444,
   * bilive/@types/danmaku.d.ts (MIT), PK_BATTLE_END.
   * No upstream implementation is copied. Init/match are protocol sides,
   * not assumed to be the current room. best_uname is a supporter, not a host.
   */
  private static ObjectNode bilibili(MessageMsg wire, long receivedAt) throws IOException {
    String protocol = wire.getCmd();
    if (protocol == null) return null;
    boolean preparing = BILI_PRE.contains(protocol), starting = BILI_START.contains(protocol);
    boolean progress = BILI_PROGRESS.contains(protocol), ended = "PK_BATTLE_END".equals(protocol);
    if (!preparing && !starting && !progress && !ended) return null;
    JsonNode data = wire.getData();
    if (data == null || !data.isObject()) throw new IOException("Invalid Bilibili PK data");
    String battle = decimal(wire.getUnknownProperties().get("pk_id"), false);
    if (battle.isEmpty()) return null;
    ObjectNode pk = base(battle, preparing ? "preparing" : ended ? "ended" : "active", protocol, receivedAt)
      .put("reason", preparing ? "battle-preparing" : starting ? "battle-started" : ended ? "battle-finished" : "battle-progress");
    JsonNode timestamp = wire.getUnknownProperties().get("timestamp");
    if (timestamp != null && !timestamp.isNull()) {
      long source = epochSeconds(timestamp);
      if (source == 0 || !sourceTime(pk, source / 1000, receivedAt)) return null;
    }
    String unit = boundedText(data.get("pk_votes_name"), 32);
    if (!unit.isBlank()) pk.put("scoreUnit", unit);
    var participants = JSON.createArrayNode();
    if (preparing) {
      ObjectNode opponent = participant(data, "opponent");
      if (opponent == null) return null;
      // Respect explicit privacy flags even if a future packet carries an ID
      // alongside them. Do not resolve/cache any extra profile information.
      boolean hidden = data.path("is_mystery").asBoolean(false)
        || data.path("uinfo").path("base").path("is_mystery").asBoolean(false);
      if (!hidden) {
        String uid = decimal(data.get("uid"), false), name = boundedText(data.get("uname"), 128);
        String avatar = bilibiliAvatar(data.get("face"));
        if (!uid.isEmpty()) opponent.put("userId", uid);
        if (!name.isEmpty()) opponent.put("userName", name);
        if (!avatar.isEmpty()) opponent.put("avatarUrl", avatar);
      }
      participants.add(opponent);
    } else {
      ObjectNode init = participant(data.get("init_info"), "init");
      ObjectNode match = participant(data.get("match_info"), "match");
      // Never publish two entries for the same room or assign an orphan score.
      if (init != null && match != null && init.path("roomId").equals(match.path("roomId"))) return null;
      if (init != null) participants.add(init);
      if (match != null) participants.add(match);
      if ((progress || ended) && participants.isEmpty()) return null;
    }
    if (!participants.isEmpty()) pk.set("participants", participants);
    if (starting) {
      long started = epochSeconds(data.get("pk_start_time")), ends = epochSeconds(data.get("pk_end_time"));
      if (started > 0) pk.put("startedAt", started);
      if (ends > 0 && started > 0 && ends > started && ends - started <= 3_600_000) pk.put("endsAt", ends);
      if (started > receivedAt + 30_000 || (ends > 0 && ends < receivedAt - 90_000)) return null;
    }
    // The old and NEW command variants can describe the same update. Hash only
    // normalized protocol evidence, not receive time or the spelling of command.
    ObjectNode identity = pk.deepCopy();
    identity.remove(java.util.List.of("observedAt", "protocol"));
    return event(pk, "bilibili-pk:" + digest(ByteString.copyFrom(JSON.writeValueAsBytes(identity))));
  }

  private static ObjectNode participant(JsonNode data, String side) {
    if (data == null || !data.isObject()) return null;
    String roomId = decimal(data.get("room_id"), false);
    if (roomId.isEmpty()) return null;
    ObjectNode value = JSON.createObjectNode().put("side", side).put("roomId", roomId);
    String score = decimal(data.get("votes"), true);
    if (!score.isEmpty() && new java.math.BigInteger(score).bitLength() <= 64) value.put("score", score);
    return value;
  }

  private static String decimal(JsonNode value, boolean zero) {
    if (value == null || (!value.isTextual() && !value.isIntegralNumber())) return "";
    String text = value.asText();
    return text.matches(zero ? "(0|[1-9][0-9]{0,19})" : "[1-9][0-9]{0,19}") ? text : "";
  }

  private static long epochSeconds(JsonNode value) {
    String text = decimal(value, false);
    if (text.isEmpty() || text.length() > 10) return 0;
    long seconds = Long.parseLong(text);
    return seconds >= EARLIEST_EPOCH / 1000 && seconds <= LATEST_EPOCH / 1000 ? seconds * 1000 : 0;
  }

  private static String boundedText(JsonNode value, int limit) {
    if (value == null || !value.isTextual()) return "";
    String text = value.asText();
    return text.length() <= limit && text.chars().noneMatch(ch -> ch < 32 || ch == 127) ? text : "";
  }

  private static String bilibiliAvatar(JsonNode value) {
    String text = boundedText(value, 4096);
    if (text.isEmpty()) return "";
    try {
      URI url = URI.create(text.startsWith("//") ? "https:" + text : text);
      String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
      if (!Set.of("http", "https").contains(url.getScheme()) || url.getUserInfo() != null || url.getPort() != -1
          || !(host.equals("hdslb.com") || host.endsWith(".hdslb.com"))) return "";
      return "http".equals(url.getScheme()) ? "https" + url.toString().substring(4) : url.toString();
    } catch (IllegalArgumentException invalid) { return ""; }
  }

  static ObjectNode base(String battle, String phase, String protocol, long receivedAt) {
    ObjectNode pk = JSON.createObjectNode().put("phase", phase).put("protocol", protocol).put("observedAt", receivedAt);
    if (battle == null) pk.putNull("battleId"); else pk.put("battleId", battle);
    return pk;
  }

  static ObjectNode event(ObjectNode pk, String id) {
    return JSON.createObjectNode().put("event_type", "pk_status").put("source_msg_id", id).put("event_id", id).set("pk", pk);
  }

  static boolean sourceTime(ObjectNode pk, long raw, long receivedAt) {
    if (raw == 0) return true;
    pk.put("sourceTime", Long.toUnsignedString(raw));
    long timestamp = raw >= EARLIEST_EPOCH && raw <= LATEST_EPOCH ? raw :
      raw >= EARLIEST_EPOCH / 1000 && raw <= LATEST_EPOCH / 1000 ? raw * 1000 : 0;
    if (timestamp == 0) return true; // Unknown units stay raw, never become a countdown.
    if (timestamp < receivedAt - 90_000 || timestamp > receivedAt + 30_000) return false;
    pk.put("sourceTimestamp", timestamp);
    return true;
  }

  static java.util.Map<Integer, Long> numbers(ByteString bytes, Set<Integer> fields) throws IOException {
    CodedInputStream input = bytes.newCodedInput();
    input.setRecursionLimit(8);
    var values = new java.util.HashMap<Integer, Long>();
    for (int n = 0, tag; (tag = input.readTag()) != 0; n++) {
      if (n >= 1024) throw new IOException("PK nested field limit");
      int field = tag >>> 3;
      if (fields.contains(field)) {
        if ((tag & 7) != 0 || values.containsKey(field)) throw new IOException("Invalid PK numeric field");
        values.put(field, input.readUInt64());
      } else if (!input.skipField(tag)) throw new IOException("Invalid PK nested wire field");
    }
    return values;
  }

  private static boolean validId(String value) {
    return value != null && !value.isBlank() && !"0".equals(value) && value.length() <= 128 &&
      value.chars().noneMatch(ch -> ch < 32 || ch == 127);
  }
  static void checkSize(ByteString value) throws IOException {
    if (value.isEmpty() || value.size() > LIMIT) throw new IOException("Invalid PK payload size");
  }
  static String digest(ByteString bytes) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray())).substring(0, 32); }
    catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
  }
}
