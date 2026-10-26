package local.furryup;

import cn.hutool.core.lang.Pair;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.protobuf.CodedOutputStream;
import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.zip.DeflaterOutputStream;
import tech.ordinaryroad.live.chat.client.bilibili.listener.IBilibiliMsgListener;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliCodecHandler;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.SendGiftMsg;

/** Twenty synthetic flowers, real SDK zlib decoding/dispatch, no live connection. */
public final class BilibiliGiftComboFixture {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static void frame(EmbeddedChannel channel, String command, String data) throws Exception {
    byte[] body = JSON.createObjectNode().put("cmd", command).set("data", JSON.readTree(data)).toString().getBytes(StandardCharsets.UTF_8);
    var plain = Unpooled.buffer(16 + body.length);
    plain.writeInt(16 + body.length).writeShort(16).writeShort(0).writeInt(5).writeInt(1).writeBytes(body);
    var compressed = new ByteArrayOutputStream();
    try (var zip = new DeflaterOutputStream(compressed)) { byte[] raw = new byte[plain.readableBytes()]; plain.readBytes(raw); zip.write(raw); }
    finally { plain.release(); }
    byte[] packed = compressed.toByteArray(); var bytes = Unpooled.buffer(16 + packed.length);
    bytes.writeInt(16 + packed.length).writeShort(16).writeShort(2).writeInt(5).writeInt(1).writeBytes(packed);
    channel.writeInbound(new BinaryWebSocketFrame(bytes));
  }
  private static String v2(int count, String transaction) throws Exception {
    var gift = new ByteArrayOutputStream(); var item = CodedOutputStream.newInstance(gift);
    item.writeInt64(1, 31036); item.writeString(2, "小花花"); item.writeInt32(3, count); item.writeString(9, transaction); item.flush();
    var bytes = new ByteArrayOutputStream(); var root = CodedOutputStream.newInstance(bytes);
    root.writeInt64(1, 12345); root.writeString(2, "示例观众"); root.writeByteArray(10, gift.toByteArray()); root.flush();
    return JSON.createObjectNode().put("pb", Base64.getEncoder().encodeToString(bytes.toByteArray())).toString();
  }
  public static void main(String[] args) throws Exception {
    PrintStream errors = System.err;
    try {
      Class.forName(Collector.class.getName());
      System.setOut(new PrintStream(OutputStream.nullOutputStream())); System.setErr(new PrintStream(OutputStream.nullOutputStream()));
      var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, "bilibili");
      field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
      // Legacy SDK images use a catalog request. Clear only this fixture's room
      // context before the production listener, so this test remains offline.
      var metadata = (IBilibiliMsgListener)Proxy.newProxyInstance(IBilibiliMsgListener.class.getClassLoader(), new Class<?>[]{IBilibiliMsgListener.class},
        (proxy, method, values) -> { if (values != null && values.length > 0 && values[values.length - 1] instanceof SendGiftMsg gift) gift.setRoomId(0L); return null; });
      var channel = new EmbeddedChannel(new BilibiliCodecHandler(), new BilibiliBinaryFrameHandler(List.of(metadata, Collector.listener(IBilibiliMsgListener.class)), 1L, Pair.of(1L, 0L)));
      try {
        boolean bulk = args.length > 0 && args[0].equals("v2-bulk");
        if (bulk) { String gift = v2(20, "synthetic-bulk"); frame(channel, "SEND_GIFT_V2", gift); frame(channel, "SEND_GIFT_V2:compat", gift); }
        for (int i = 1; i <= 20; i++) {
          if (!bulk) {
            var gift = JSON.createObjectNode().put("uid", 12345).put("uname", "示例观众").put("giftId", 31036).put("giftName", "小花花")
              .put("num", 1).put("tid", "synthetic-flower-" + i).put("batch_combo_id", "synthetic-combo");
            frame(channel, "SEND_GIFT", gift.toString());
            frame(channel, "SEND_GIFT_V2:compat", v2(1, "synthetic-flower-" + i)); // Same transaction, not another gift.
          }
          frame(channel, "COMBO_SEND", JSON.createObjectNode().put("uid", 12345).put("gift_id", 31036).put("gift_name", "小花花")
            .put("combo_num", i).put("batch_combo_num", i).put("total_num", i).put("gift_num", 0).put("batch_combo_id", "synthetic-combo").toString());
        }
      } finally { channel.finishAndReleaseAll(); }
      System.exit(0);
    } catch (Throwable error) { error.printStackTrace(errors); System.exit(1); }
  }
}
