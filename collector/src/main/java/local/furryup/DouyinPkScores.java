package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.protobuf.ByteString;
import com.google.protobuf.CodedInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.DouyinCmdMsg;

/**
 * Original, bounded adapter for public Douyin web protocol definitions, read on
 * 2026-10-20 without a room connection. Reference assets, not redistributed:
 * https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/live-schema-im.e322bd8a.js
 * https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/PKViewPlugin.de2e4662.js
 * https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/client-entry~1.28f20eec.js
 *
 * PKViewPlugin maps LinkMicMethod.user_scores to pkScores, and LinkMicArmies to
 * the separate contributor leaderboard. Module 378470 defines UPDATE as "202".
 * Only explicit battle IDs are accepted; this class never guesses a current
 * battle from a prior room/message and never copies the official implementation.
 */
final class DouyinPkScores {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final Set<Integer> UPDATE_NUMBERS = Set.of(1, 2, 5, 6, 8, 9, 11, 12, 13, 15, 16, 17, 18);
  private static final Set<Integer> UPDATE_TEXT = Set.of(4, 7, 10, 14, 19, 21);
  private static final Set<Integer> FINISH_NUMBERS = Set.of(1, 2, 11, 13, 14, 16, 17, 19, 20, 21, 23, 24);
  private static final Set<Integer> FINISH_TEXT = Set.of(8, 12, 15, 18);

  private DouyinPkScores() {}

  static boolean supports(String method) { return "WebcastLinkMicMethod".equals(method); }

  static ObjectNode decode(DouyinCmdMsg command, long receivedAt) throws IOException {
    ByteString payload = command.getMsg().getPayload();
    PkEvents.checkSize(payload);
    CodedInputStream input = reader(payload);
    Long type = null, numericBattle = null;
    String textBattle = null;
    ByteString common = null;
    var scores = new ArrayList<ByteString>();
    boolean tooMany = false;
    var seen = new HashSet<Integer>();
    for (int n = 0, tag; (tag = input.readTag()) != 0; n++) {
      if (n >= 2048) throw new IOException("PK field limit");
      int field = tag >>> 3;
      if (field == 17) {
        wireType(tag, 2);
        ByteString score = input.readBytes();
        if (scores.size() < 2) scores.add(score); else tooMany = true;
      } else if (field == 1 || field == 2 || field == 104 || field == 114) {
        if (!seen.add(field)) throw new IOException("Duplicate PK field");
        wireType(tag, field == 1 || field == 114 ? 2 : 0);
        if (field == 1) common = input.readBytes();
        else if (field == 2) type = input.readInt64();
        else if (field == 104) numericBattle = input.readInt64();
        else textBattle = input.readStringRequireUtf8();
      } else skip(input, tag);
    }
    // Ordinary linking, restarting and quitting do not imply an active battle.
    if (type == null || type != 202 || common == null || common.isEmpty() || tooMany || scores.isEmpty()) return null;
    String battle = exactId(numericBattle, textBattle);
    if (battle.isEmpty()) return null;
    ArrayNode participants = participants(scores, false);
    if (participants.isEmpty()) return null;
    var header = PkEvents.numbers(common, Set.of(2, 3, 4));
    ObjectNode pk = PkEvents.base(battle, "active", command.getMsg().getMethod(), receivedAt).put("reason", "battle-progress");
    if (!PkEvents.sourceTime(pk, header.getOrDefault(4, 0L), receivedAt)) return null;
    pk.set("participants", participants);
    Long messageId = header.get(2);
    String id = messageId != null && messageId != 0 ? Long.toUnsignedString(messageId) : PkEvents.digest(payload);
    return PkEvents.event(pk, "douyin-pk:" + command.getMsg().getMethod() + ":" + id);
  }

  static ArrayNode finish(ByteString payload) throws IOException {
    CodedInputStream input = reader(payload);
    var scores = new ArrayList<ByteString>();
    boolean tooMany = false;
    for (int n = 0, tag; (tag = input.readTag()) != 0; n++) {
      if (n >= 2048) throw new IOException("PK field limit");
      if ((tag >>> 3) == 4) {
        wireType(tag, 2);
        ByteString score = input.readBytes();
        if (scores.size() < 2) scores.add(score); else tooMany = true;
      } else skip(input, tag);
    }
    return tooMany ? JSON.createArrayNode() : participants(scores, true);
  }

  private static ArrayNode participants(List<ByteString> rows, boolean finish) throws IOException {
    ArrayNode result = JSON.createArrayNode();
    var identities = new HashSet<String>();
    for (ByteString row : rows) {
      ObjectNode participant = score(row, finish);
      // A conflicting/malformed side invalidates the pair. Do not turn a team
      // battle into a two-person subset or merge duplicate IDs' scores.
      if (participant == null || !identities.add(participant.path("userId").asText())) return JSON.createArrayNode();
      result.add(participant);
    }
    return result;
  }

  private static ObjectNode score(ByteString bytes, boolean finish) throws IOException {
    CodedInputStream input = reader(bytes);
    Map<Integer, Long> numbers = new HashMap<>();
    Map<Integer, String> texts = new HashMap<>();
    Set<Integer> numericFields = finish ? FINISH_NUMBERS : UPDATE_NUMBERS;
    Set<Integer> textFields = finish ? FINISH_TEXT : UPDATE_TEXT;
    for (int n = 0, tag; (tag = input.readTag()) != 0; n++) {
      if (n >= 128) throw new IOException("PK score field limit");
      int field = tag >>> 3;
      if (numericFields.contains(field)) {
        wireType(tag, 0);
        if (numbers.containsKey(field)) throw new IOException("Duplicate PK score field");
        numbers.put(field, input.readInt64());
      } else if (textFields.contains(field)) {
        wireType(tag, 2);
        if (texts.containsKey(field)) throw new IOException("Duplicate PK score text");
        texts.put(field, input.readStringRequireUtf8());
      } else skip(input, tag);
    }
    String uid = exactId(numbers.get(2), texts.get(finish ? 8 : 21));
    if (uid.isEmpty()) return null;
    int teamScore = finish ? 19 : 11, teamRank = finish ? 20 : 12, relativeTeam = finish ? 21 : 13, teamText = finish ? 18 : 10;
    if (numbers.getOrDefault(teamScore, 0L) != 0 || numbers.getOrDefault(teamRank, 0L) != 0
        || numbers.getOrDefault(relativeTeam, 0L) != 0 || !texts.getOrDefault(teamText, "").isEmpty()) return null;
    ObjectNode value = JSON.createObjectNode().put("side", "participant").put("userId", uid);
    String relative = texts.getOrDefault(finish ? 12 : 4, "");
    String blurred = texts.getOrDefault(finish ? 15 : 7, "");
    // Never reveal the accompanying raw number when the official protocol asks
    // to display a relative/blurred score, even if that display text is invalid.
    boolean displayOnly = !relative.isEmpty() || !blurred.isEmpty() || (finish && numbers.getOrDefault(11, 0L) != 0);
    if (displayOnly) {
      String display = blurred.isBlank() ? relative : blurred;
      if (display.length() <= 64 && !display.isBlank() && display.chars().noneMatch(ch -> ch < 32 || ch == 127))
        value.put("scoreDisplay", display);
    } else {
      Long score = numbers.get(1);
      // BattleScore.score is int32; UserScores.score is int64. Missing zero must
      // stay missing, and signed negatives must not turn into uint64 totals.
      if (score != null && score >= 0 && (!finish || score <= Integer.MAX_VALUE)) value.put("score", Long.toString(score));
    }
    return value;
  }

  private static String exactId(Long numeric, String text) {
    if (numeric != null && numeric < 0) return "";
    String id = numeric != null && numeric > 0 ? Long.toString(numeric) : "";
    if (text == null || text.isEmpty()) return id;
    if (!text.matches("[1-9][0-9]{0,19}") || (!id.isEmpty() && !id.equals(text))) return "";
    return text;
  }

  private static CodedInputStream reader(ByteString bytes) {
    CodedInputStream input = bytes.newCodedInput();
    input.setRecursionLimit(8);
    return input;
  }
  private static void wireType(int tag, int expected) throws IOException {
    if ((tag & 7) != expected) throw new IOException("Invalid PK field type");
  }
  private static void skip(CodedInputStream input, int tag) throws IOException {
    if (!input.skipField(tag)) throw new IOException("Invalid PK field");
  }
}
