package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.protobuf.CodedOutputStream;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.List;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.SendGiftMsg;

/** Offline V2 metadata regression. Material images must never fetch a catalog. */
public final class BilibiliGiftMetadataFixture {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final String IMAGE = "https://i0.hdslb.com/bfs/live/fixture-gift.png";
  private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
  private static byte[] material(String image) throws Exception {
    var bytes = new ByteArrayOutputStream(); var out = CodedOutputStream.newInstance(bytes);
    out.writeString(1, image); out.writeInt32(99, 1); out.flush(); return bytes.toByteArray();
  }
  private static byte[] item(int id, int count, Long price, String coin, byte[] material) throws Exception {
    var bytes = new ByteArrayOutputStream(); var out = CodedOutputStream.newInstance(bytes);
    out.writeInt64(1, id); out.writeString(2, "示例礼物"); out.writeInt32(3, count);
    if (price != null) out.writeInt64(5, price);
    // Intentionally differs from price*count (discount/blind-box scenarios).
    out.writeInt64(7, 500); if (coin != null) out.writeString(8, coin);
    out.writeString(9, "shared-transaction"); out.writeInt64(10, 1700000000);
    out.writeString(12, "original-rnd");
    if (material != null) out.writeByteArray(35, material);
    out.writeString(99, "future"); out.flush(); return bytes.toByteArray();
  }
  private static String batch(byte[]... items) throws Exception {
    var bytes = new ByteArrayOutputStream(); var out = CodedOutputStream.newInstance(bytes);
    out.writeInt64(1, 12345); out.writeString(2, "示例观众");
    out.writeString(3, "https://i0.hdslb.com/avatar-fixture.png");
    for (byte[] item : items) out.writeByteArray(10, item);
    out.flush(); return Base64.getEncoder().encodeToString(bytes.toByteArray());
  }
  private static ObjectNode normalize(SendGiftMsg message) { return Collector.normalizeEvent("onGiftMsg", message); }
  public static void main(String[] args) throws Exception {
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, "bilibili");
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
    String payload = batch(item(11, 2, 1000L, "gold", material(IMAGE)), item(12, 3, 20L, "silver", null));
    List<SendGiftMsg> gifts = BilibiliGiftV2.decode(payload);
    require(gifts.size() == 2, "every batch item survives");
    var first = normalize(gifts.get(0)); var second = normalize(gifts.get(1));
    require(first.path("gift_count").asInt() == 2 && second.path("gift_count").asInt() == 3, "exact batch quantities");
    require(first.path("gift_price_raw").asInt() == 1000 && second.path("gift_price_raw").asInt() == 20, "wire unit prices, not inferred totals");
    require(first.path("gift_price_unit").asText().equals("bilibili_coin"), "platform unit retained");
    require(first.path("gift_coin_type").asText().equals("gold") && second.path("gift_coin_type").asText().equals("silver"), "coin type retained");
    require(first.path("gift_image_url").asText().equals(IMAGE) && !second.has("gift_image_url"), "snapshot image and honest missing image");
    require(gifts.get(0).getRoomId() == 0 && gifts.get(0).getGiftImg().equals(IMAGE) && gifts.get(1).getGiftImg().isEmpty(), "images independent of live room or catalog request");
    require(first.path("source_msg_id").asText().equals("bili-gift:shared-transaction:11") &&
      second.path("source_msg_id").asText().equals("bili-gift:shared-transaction:12"), "transaction/item identity unchanged");
    var replay = BilibiliGiftV2.decodeData(JSON.createObjectNode().set("data", JSON.createObjectNode().put("pb", payload)));
    require(first.path("source_msg_id").equals(normalize(replay.get(0)).path("source_msg_id")), "nested/replay identity stable");
    var v1 = new SendGiftMsg(); var data = new SendGiftMsg.Data();
    data.setUid(12345); data.setGiftId(11); data.setNum(2); data.setTid("shared-transaction"); v1.setData(data);
    require(first.path("source_msg_id").equals(normalize(v1).path("source_msg_id")), "V1/V2 overlap keeps same deduplication identity");
    for (Long invalid : new Long[]{null, 0L, -1L, (long)Integer.MAX_VALUE + 1, Long.MAX_VALUE}) {
      var event = normalize(BilibiliGiftV2.decode(batch(item(13, 4, invalid, null, null))).get(0));
      require(!event.has("gift_price_raw") && !event.has("gift_coin_type") && event.path("gift_count").asInt() == 4, "unknown/overflow metadata cannot invent value or discard gift");
    }
    for (byte[] invalid : new byte[][]{new byte[]{10, 8, 65}, material("x".repeat(4097))}) {
      var event = normalize(BilibiliGiftV2.decode(batch(item(14, 1, 50L, "gold", invalid))).get(0));
      require(!event.has("gift_image_url") && event.path("gift_price_raw").asInt() == 50, "invalid optional artwork keeps real gift");
    }
    System.out.println("PASS: V2 wire unit prices, coin type and material images; missing/overflow metadata; quantities and V1/V2 replay identity; no catalog dependency");
  }
}
