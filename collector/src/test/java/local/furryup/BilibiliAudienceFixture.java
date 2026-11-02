package local.furryup;

import cn.hutool.core.lang.Pair;
import io.netty.buffer.Unpooled;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.DeflaterOutputStream;
import tech.ordinaryroad.live.chat.client.bilibili.listener.IBilibiliMsgListener;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliCodecHandler;

/** Real SDK compressed dispatch, exact integers, repeated values and absent data. */
public final class BilibiliAudienceFixture {
  private static void frame(EmbeddedChannel channel, String command, String data) throws Exception {
    byte[] body = ("{\"cmd\":\"" + command + "\",\"data\":" + data + "}").getBytes(StandardCharsets.UTF_8);
    var plain = Unpooled.buffer(16 + body.length);
    plain.writeInt(16 + body.length).writeShort(16).writeShort(0).writeInt(5).writeInt(1).writeBytes(body);
    var compressed = new ByteArrayOutputStream();
    try (var zip = new DeflaterOutputStream(compressed)) { byte[] raw = new byte[plain.readableBytes()]; plain.readBytes(raw); zip.write(raw); }
    finally { plain.release(); }
    byte[] packed = compressed.toByteArray(); var bytes = Unpooled.buffer(16 + packed.length);
    bytes.writeInt(16 + packed.length).writeShort(16).writeShort(2).writeInt(5).writeInt(1).writeBytes(packed);
    channel.writeInbound(new BinaryWebSocketFrame(bytes));
  }
  public static void main(String[] args) throws Exception {
    PrintStream errors = System.err;
    try {
      Class.forName(Collector.class.getName());
      System.setOut(new PrintStream(OutputStream.nullOutputStream())); System.setErr(new PrintStream(OutputStream.nullOutputStream()));
      var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, "bilibili");
      field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
      var traffic = new AtomicInteger();
      var channel = new EmbeddedChannel(BilibiliAuthenticatedClient.transportHandler(traffic::incrementAndGet),
        new BilibiliCodecHandler(), new BilibiliBinaryFrameHandler(List.of(Collector.listener(IBilibiliMsgListener.class)), 1L, Pair.of(1L, 0L)));
      try {
        frame(channel, "ONLINE_RANK_COUNT", "{\"online_count\":5,\"count\":1}");
        frame(channel, "ONLINE_RANK_COUNT", "{\"online_count\":5}");
        frame(channel, "ONLINE_RANK_COUNT", "{\"online_count\":0}");
        frame(channel, "ONLINE_RANK_COUNT:compat", "{\"online_count\":\"12\"}");
        for (String data : List.of("{}", "{\"count\":9}", "{\"online_count_text\":\"1万+\"}",
          "{\"online_count\":null}", "{\"online_count\":false}", "{\"online_count\":-1}",
          "{\"online_count\":1.5}", "{\"online_count\":\"12人\"}", "{\"online_count\":1000000000001}"))
          frame(channel, "ONLINE_RANK_COUNT", data);
        frame(channel, "WATCHED_CHANGE", "{\"num\":200}");
        if (traffic.get() != 1) throw new AssertionError("Transport metadata must be bounded independently of count events");
      } finally { channel.finishAndReleaseAll(); }
      System.exit(0);
    } catch (Throwable error) { error.printStackTrace(errors); System.exit(1); }
  }
}
