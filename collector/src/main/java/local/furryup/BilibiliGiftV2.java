package local.furryup;

import com.google.protobuf.CodedInputStream;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.*;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.SendGiftMsg;

/** SEND_GIFT_V2 field layout documented by blivedm (MIT); see THIRD_PARTY_NOTICES.md. */
final class BilibiliGiftV2 {
  private record Gift(long id, String name, int count, String tid, String rnd, long timestamp,
      long price, String coinType, String image) {}
  // V2 carries a material snapshot in the message. Do not route a missing image
  // through the SDK getter: each cache miss starts another catalog request.
  static final class SnapshotGift extends SendGiftMsg {
    private final String image;
    SnapshotGift(String image) { this.image = image; }
    @Override public String getGiftImg() { return image; }
  }
  static List<SendGiftMsg> decodeData(JsonNode data) throws IOException {
    if (data == null || !data.isObject()) throw new IOException("Missing gift data");
    JsonNode pb = data.path("pb");
    if (pb.isMissingNode() || pb.isNull() || (pb.isTextual() && pb.asText().isBlank()))
      pb = data.path("data").path("pb");
    if (!pb.isTextual()) throw new IOException("Missing gift protobuf");
    return decode(pb.asText());
  }
  static List<SendGiftMsg> decode(String encoded) throws IOException {
    if (encoded == null || encoded.isBlank() || encoded.length() > 512 * 1024) throw new IOException("Invalid gift payload size");
    final byte[] bytes;
    try { bytes = Base64.getDecoder().decode(encoded); }
    catch (IllegalArgumentException error) { throw new IOException("Invalid gift encoding"); }
    CodedInputStream input = CodedInputStream.newInstance(bytes); input.setRecursionLimit(16);
    long uid = 0; String name = "", face = ""; List<Gift> gifts = new ArrayList<>();
    for (int tag; (tag = input.readTag()) != 0;) {
      switch (tag) {
        case 8 -> uid = input.readInt64();
        case 18 -> name = input.readStringRequireUtf8();
        case 26 -> face = input.readStringRequireUtf8();
        case 82 -> {
          if (gifts.size() >= 128) throw new IOException("Too many gift entries");
          gifts.add(readGift(input.readByteArray()));
        }
        default -> { if (!input.skipField(tag)) throw new IOException("Unexpected gift group"); }
      }
    }
    List<SendGiftMsg> result = new ArrayList<>(); int index = 0;
    for (Gift gift : gifts) {
      int itemIndex = index++;
      if (gift.count <= 0 || gift.count > 1_000_000) continue;
      SendGiftMsg.Data data = new SendGiftMsg.Data();
      data.setUid(uid); data.setUname(name); data.setFace(face);
      if (gift.id < 0 || gift.id > Integer.MAX_VALUE) continue;
      data.setGiftId((int)gift.id); data.setGiftName(gift.name); data.setNum(gift.count);
      data.setTimestamp(gift.timestamp); data.setRnd(gift.rnd);
      // This is the wire gift's unit value, not a computed total or the amount
      // actually paid for a blind box. Missing/overflow values stay unknown.
      if (gift.price > 0 && gift.price <= Integer.MAX_VALUE) data.setPrice((int)gift.price);
      if (!gift.coinType.isBlank() && gift.coinType.length() <= 32) data.setCoin_type(gift.coinType);
      // Preserve per-transaction identity across V1/V2; otherwise deduplicate batch replay.
      data.setTid(!gift.tid.isBlank() ? gift.tid : !gift.rnd.isBlank() ? gift.rnd : "v2-" + digest(bytes) + "-" + itemIndex);
      SendGiftMsg message = new SnapshotGift(gift.image); message.setData(data); result.add(message);
    }
    return result;
  }
  private static Gift readGift(byte[] bytes) throws IOException {
    CodedInputStream input = CodedInputStream.newInstance(bytes); input.setRecursionLimit(16);
    long id = 0, timestamp = 0, price = 0; int count = 0;
    String name = "", tid = "", rnd = "", coinType = "", image = "";
    for (int tag; (tag = input.readTag()) != 0;) {
      switch (tag) {
        case 8 -> id = input.readInt64();
        case 18 -> name = input.readStringRequireUtf8();
        case 24 -> count = input.readInt32();
        // blivedm/models/pb.py SendGiftV2GiftItem: price=5, coin_type=8,
        // gift_info=35; material snapshot img_basic=1.
        case 40 -> price = input.readInt64();
        case 66 -> coinType = input.readStringRequireUtf8();
        case 74 -> tid = input.readStringRequireUtf8();
        case 80 -> timestamp = input.readInt64();
        case 98 -> rnd = input.readStringRequireUtf8();
        case 282 -> {
          byte[] material = input.readByteArray();
          try { image = readMaterialImage(material); }
          catch (IOException ignored) { /* Optional artwork cannot discard a paid gift. */ }
        }
        default -> { if (!input.skipField(tag)) throw new IOException("Unexpected gift item group"); }
      }
    }
    return new Gift(id, name, count, tid, rnd, timestamp, price, coinType, image);
  }
  private static String readMaterialImage(byte[] bytes) throws IOException {
    CodedInputStream input = CodedInputStream.newInstance(bytes); input.setRecursionLimit(16);
    String image = "";
    for (int tag; (tag = input.readTag()) != 0;) {
      if (tag == 10) image = input.readStringRequireUtf8();
      else if (!input.skipField(tag)) throw new IOException("Unexpected gift material group");
    }
    return image.length() <= 4096 ? image : "";
  }
  private static String digest(byte[] bytes) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
  }
}
