package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.protobuf.ByteString;
import com.google.protobuf.CodedInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Set;
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

  private PkEvents() {}

  static ObjectNode decode(Object message) throws IOException { return decode(message, System.currentTimeMillis()); }

  static ObjectNode decode(Object message, long receivedAt) throws IOException {
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

  private static ObjectNode base(String battle, String phase, String protocol, long receivedAt) {
    ObjectNode pk = JSON.createObjectNode().put("phase", phase).put("protocol", protocol).put("observedAt", receivedAt);
    if (battle == null) pk.putNull("battleId"); else pk.put("battleId", battle);
    return pk;
  }

  private static ObjectNode event(ObjectNode pk, String id) {
    return JSON.createObjectNode().put("event_type", "pk_status").put("source_msg_id", id).put("event_id", id).set("pk", pk);
  }

  private static boolean sourceTime(ObjectNode pk, long raw, long receivedAt) {
    if (raw == 0) return true;
    pk.put("sourceTime", Long.toUnsignedString(raw));
    long timestamp = raw >= EARLIEST_EPOCH && raw <= LATEST_EPOCH ? raw :
      raw >= EARLIEST_EPOCH / 1000 && raw <= LATEST_EPOCH / 1000 ? raw * 1000 : 0;
    if (timestamp == 0) return true; // Unknown units stay raw, never become a countdown.
    if (timestamp < receivedAt - 90_000 || timestamp > receivedAt + 30_000) return false;
    pk.put("sourceTimestamp", timestamp);
    return true;
  }

  private static java.util.Map<Integer, Long> numbers(ByteString bytes, Set<Integer> fields) throws IOException {
    CodedInputStream input = bytes.newCodedInput();
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
  private static void checkSize(ByteString value) throws IOException {
    if (value.isEmpty() || value.size() > LIMIT) throw new IOException("Invalid PK payload size");
  }
  private static String digest(ByteString bytes) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray())).substring(0, 32); }
    catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
  }
}
