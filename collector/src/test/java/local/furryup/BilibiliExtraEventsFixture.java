package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.MessageMsg;

/** Offline documented-payload regression; no room connection or purchases are made. */
public final class BilibiliExtraEventsFixture {
  private static final ObjectMapper JSON = new ObjectMapper();

  private static List<ObjectNode> decode(String cmd, String data) throws Exception {
    MessageMsg wire = new MessageMsg(); wire.setCmd(cmd); wire.setData(JSON.readTree(data));
    return BilibiliExtraEvents.decode(wire);
  }
  private static ObjectNode one(String cmd, String data) throws Exception {
    var events = decode(cmd, data);
    require(events.size() == 1, "one event: " + cmd);
    return events.getFirst();
  }
  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  private static String membership(int level, int count, long started) {
    return "{\"uid\":12345,\"username\":\"小雪❄️🐾\",\"guard_level\":" + level
      + ",\"num\":" + count + ",\"price\":138000,\"gift_id\":10003,\"start_time\":" + started + "}";
  }
  private static String toastV2(int source) {
    return "{\"sender_uinfo\":{\"uid\":12345,\"base\":{\"name\":\"小雪❄️🐾\",\"face\":\"https://i0.hdslb.com/snow.png\"}},"
      + "\"guard_info\":{\"guard_level\":3,\"start_time\":1700000000},"
      + "\"pay_info\":{\"num\":2,\"price\":138000,\"unit\":\"月\"},"
      + "\"gift_info\":{\"gift_id\":10003},\"option\":{\"source\":" + source + "}}";
  }
  private static void invalid(String cmd, String payload) throws Exception {
    try { decode(cmd, payload); throw new AssertionError("malformed payload accepted: " + cmd); }
    catch (IOException expected) { }
  }

  public static void main(String[] args) throws Exception {
    for (String cmd : new String[]{"GUARD_BUY", "USER_TOAST_MSG", "USER_TOAST_MSG_V2", "ENTRY_EFFECT",
        "ENTRY_EFFECT_MUST_RECEIVE", "SUPER_CHAT_MESSAGE_DELETE"}) {
      require(BilibiliExtraEvents.supports(cmd), "supported command");
      require(BilibiliExtraEvents.supports(cmd + ":compat"), "suffix command");
      invalid(cmd, "null"); invalid(cmd, "[]");
    }
    require(!BilibiliExtraEvents.supports(null) && !BilibiliExtraEvents.supports("OTHER"), "unknown command");
    require(decode("OTHER", "null").isEmpty(), "ignore unknown payload");
    require(BilibiliExtraEvents.decode(null).isEmpty(), "ignore absent wire");

    String[] names = {"", "总督", "提督", "舰长"};
    for (int level = 1; level <= 3; level++) {
      ObjectNode event = one("GUARD_BUY", membership(level, 2, 1700000000));
      require(event.path("event_type").asText().equals("gift"), "membership gift route");
      require(event.path("gift_id").asText().equals("guard-" + level), "bindable stable guard ID");
      require(event.path("gift_name").asText().equals(names[level]), "membership level");
      require(event.path("gift_kind").asText().equals("membership"), "membership kind");
      require(event.path("gift_count").asInt() == 2 && event.path("count_mode").asText().equals("delta"), "explicit quantity");
      require(event.has("value") && event.path("value").isNull(), "no invented monetary value");
      require(event.path("gift_price_raw").asLong() == 138000 && event.path("gift_price_unit").asText().equals("bilibili_coin"), "actual platform price");
      require(!event.has("membership_action") && !event.has("gift_unit"), "no guessed action or unit");
      require(event.path("user_name").asText().equals("小雪❄️🐾") && event.path("user_id").asText().equals("12345"), "Unicode identity");
    }

    ObjectNode guard = one("GUARD_BUY", membership(3, 2, 1700000000));
    ObjectNode legacy = one("USER_TOAST_MSG:compat", membership(3, 2, 1700000000));
    ObjectNode v2 = one("USER_TOAST_MSG_V2", toastV2(0));
    var ids = new HashSet<String>(); long paidCount = 0;
    for (ObjectNode event : List.of(guard, legacy, v2, guard.deepCopy())) {
      require(event.path("source_msg_id").asText().equals(event.path("event_id").asText()), "host dedupe ID");
      if (ids.add(event.path("event_id").asText())) paidCount += event.path("gift_count").asInt();
    }
    require(ids.size() == 1 && paidCount == 2, "purchase/toast/replay cannot double count");
    require(!guard.path("event_id").asText().equals(one("GUARD_BUY", membership(3, 2, 1700000001)).path("event_id").asText()), "subsequent purchase retains new identity");
    require(v2.path("avatar_url").asText().equals("https://i0.hdslb.com/snow.png") && v2.path("gift_unit").asText().equals("月"), "V2 optional fields");
    require(decode("USER_TOAST_MSG_V2", toastV2(2)).isEmpty(), "source 2 duplicate toast suppressed");
    require(decode("USER_TOAST_MSG", "{\"source\":2}").isEmpty(), "legacy gifted toast suppressed");
    ObjectNode noPrice = one("GUARD_BUY", membership(3, 2, 1700000000).replace("138000", "0"));
    require(!noPrice.has("gift_price_raw") && noPrice.path("value").isNull(), "missing price stays unknown");
    for (String payload : new String[]{"{}", membership(0, 1, 1700000000), membership(4, 1, 1700000000),
        membership(3, 0, 1700000000), membership(3, -1, 1700000000), membership(3, 1000001, 1700000000),
        membership(3, 1, 0), membership(3, 1, 1700000000).replace("12345", "0"),
        membership(3, 1, 1700000000).replace("\"num\":1", "\"num\":1.5")}) invalid("GUARD_BUY", payload);
    invalid("USER_TOAST_MSG_V2", "{\"sender_uinfo\":[]}");

    String entry = "{\"id\":135,\"uid\":438160221,\"face\":\"https://i0.hdslb.com/avatar.png\","
      + "\"copy_writing\":\"<%小雪❄️🐾%> 来了\",\"trigger_time\":1746031259272981482} ";
    ObjectNode normalEntry = one("ENTRY_EFFECT", entry);
    ObjectNode mustEntry = one("ENTRY_EFFECT_MUST_RECEIVE:compat", entry);
    require(normalEntry.path("event_id").equals(mustEntry.path("event_id")), "both entry command identities");
    require(mustEntry.path("user_name").asText().equals("小雪❄️🐾") && mustEntry.path("content").asText().equals("小雪❄️🐾 来了"), "legacy marker text extraction");
    require(mustEntry.path("avatar_url").asText().equals("https://i0.hdslb.com/avatar.png"), "entry face");
    require(!mustEntry.path("event_id").equals(one("ENTRY_EFFECT", entry.replace("1746031259272981482", "1746031259272981483")).path("event_id")), "same effect catalog ID permits another entry");
    ObjectNode newEntry = one("ENTRY_EFFECT_MUST_RECEIVE", "{\"uinfo\":{\"uid\":12345,\"base\":{\"name\":\"雪雪\",\"face\":\"https://i0.hdslb.com/new.png\"}},\"copy_writing_v2\":\"雪雪来了\"}");
    require(newEntry.path("user_name").asText().equals("雪雪") && newEntry.path("user_id").asText().equals("12345"), "current uinfo identity");
    require(newEntry.path("source_msg_id").asText().isEmpty(), "do not guess event identity from effect catalog");
    invalid("ENTRY_EFFECT_MUST_RECEIVE", "{}");

    ObjectNode delete = one("SUPER_CHAT_MESSAGE_DELETE", "{\"ids\":[42,\"9007199254740993\",42,0,-1,null,{},1.5,\"bad\"]}");
    require(delete.path("event_type").asText().equals("super_chat_delete"), "SC removal route");
    require(delete.path("super_chat_ids").toString().equals("[\"42\",\"9007199254740993\"]"), "preserve exact actual IDs and exclude invalid values");
    require(delete.path("event_id").equals(one("SUPER_CHAT_MESSAGE_DELETE:compat", "{\"ids\":[42,\"9007199254740993\"]}").path("event_id")), "SC deletion replay identity");
    require(decode("SUPER_CHAT_MESSAGE_DELETE", "{\"ids\":[]}").isEmpty(), "no invented deletion target");
    invalid("SUPER_CHAT_MESSAGE_DELETE", "{\"ids\":42}");
    invalid("SUPER_CHAT_MESSAGE_DELETE", "{\"ids\":[" + "42,".repeat(128) + "43]}");
    require(one("GUARD_BUY", membership(3, 1, 1700000002)).path("gift_count").asInt() == 1, "malformed message isolation");
    System.out.println("PASS: Bilibili memberships, V1/V2 cross-command replay identity, source 2 suppression, entry variants, exact SC removal IDs and malformed bounds.");
  }
}
