package local.furryup;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Only the platform's exact online_count is concurrent audience. Rank count,
 * popularity, cumulative views and rounded display text cannot substitute it. */
final class BilibiliAudience {
  private static final ObjectMapper JSON = new ObjectMapper();
  static boolean supports(String command) {
    return command != null && command.split(":", 2)[0].equals("ONLINE_RANK_COUNT");
  }
  static ObjectNode decode(JsonNode data) {
    JsonNode value = data == null ? null : data.get("online_count");
    if (value == null || !(value.isIntegralNumber() || value.isTextual())) return null;
    String raw = value.asText();
    if (!raw.matches("[0-9]{1,13}")) return null;
    long count = Long.parseLong(raw);
    if (count > 1_000_000_000_000L) return null;
    return JSON.createObjectNode().put("event_type", "room_stats").put("watching_count", count);
  }
}
