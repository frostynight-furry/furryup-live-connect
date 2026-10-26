package local.furryup;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame;
import java.nio.charset.StandardCharsets;
import tech.ordinaryroad.live.chat.client.codec.bilibili.api.BilibiliApis;
import tech.ordinaryroad.live.chat.client.codec.bilibili.api.response.RoomPlayInfoResult;
import tech.ordinaryroad.live.chat.client.codec.bilibili.constant.ProtoverEnum;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.UserAuthenticationMsg;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.factory.BilibiliMsgFactory;
import tech.ordinaryroad.live.chat.client.codec.bilibili.room.BilibiliRoomInitResult;
import tech.ordinaryroad.live.chat.client.codec.bilibili.util.BilibiliCodecUtil;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliCodecHandler;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliConnectionHandler;

/** Real SDK factory and encoder, synthetic room credentials, no network. */
public final class BilibiliHandshakeFixture {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static JsonNode wire(UserAuthenticationMsg message) throws Exception {
    var bytes = BilibiliCodecUtil.encode(message);
    try {
      if (bytes.getShort(6) != 1 || bytes.getInt(8) != 7) throw new AssertionError("auth must be uncompressed op 7");
      return JSON.readTree(bytes.toString(16, bytes.readableBytes() - 16, StandardCharsets.UTF_8));
    } finally { bytes.release(); }
  }
  public static void main(String[] args) throws Exception {
    var room = new BilibiliRoomInitResult(); room.setUid("12345"); room.setBuvid3("synthetic-device");
    var info = new RoomPlayInfoResult(); info.setRoom_id(99999L); room.setRoomPlayInfoResult(info);
    var token = new BilibiliApis.DanmuinfoResult(); token.setToken("synthetic-room-token"); room.setDanmuinfoResult(token);
    var original = BilibiliMsgFactory.getInstance(99999L).createAuth(ProtoverEnum.HEARTBEAT_AUTH_NO_COMPRESSION, room);
    JsonNode before = wire(original);
    if (!before.path("platform").isNull() && !before.path("platform").isMissingNode() || before.path("type").asInt() != 0 || before.path("protover").asInt() != 1)
      throw new AssertionError("SDK 1.5.8 baseline changed; reassess this adapter");
    var channel = new EmbeddedChannel(BilibiliAuthenticatedClient.authenticationHandler());
    try {
      for (int reconnect = 0; reconnect < 2; reconnect++) {
        channel.writeOutbound(original); UserAuthenticationMsg patched = channel.readOutbound(); JsonNode after = wire(patched);
        if (!after.path("platform").asText().equals("web") || after.path("type").asInt() != 2 || after.path("protover").asInt() != 2 ||
            !after.path("support_ack").asBoolean() || !after.path("scene").asText().equals("room")) throw new AssertionError("web auth fields");
        for (String key : new String[]{"uid", "roomid", "buvid", "key", "queue_uuid"})
          if (!before.path(key).equals(after.path(key))) throw new AssertionError("SDK identity/token was changed: " + key);
        if (patched == original || original.getPlatform() != null || original.getType() != 0) throw new AssertionError("do not mutate shared factory message");
      }
      var heartbeat = BilibiliMsgFactory.getInstance(99999L).createHeartbeat(ProtoverEnum.HEARTBEAT_AUTH_NO_COMPRESSION);
      channel.writeOutbound(heartbeat); if (channel.readOutbound() != heartbeat) throw new AssertionError("heartbeat must remain unchanged");
    } finally { channel.finishAndReleaseAll(); }
    // Exercise the actual SDK connection handler -> outbound adapter -> SDK
    // codec, including the Channel.writeAndFlush path used on each handshake.
    var pipeline = new EmbeddedChannel(new BilibiliCodecHandler(), BilibiliAuthenticatedClient.authenticationHandler());
    try {
      var connection = new BilibiliConnectionHandler(() -> null, room, 99999L, ProtoverEnum.HEARTBEAT_AUTH_NO_COMPRESSION);
      connection.sendAuthRequest(pipeline);
      BinaryWebSocketFrame frame = pipeline.readOutbound();
      try {
        var bytes = frame.content();
        if (bytes.getShort(6) != 1 || bytes.getInt(8) != 7) throw new AssertionError("SDK pipeline auth header");
        var body = JSON.readTree(bytes.toString(16, bytes.readableBytes() - 16, StandardCharsets.UTF_8));
        if (!body.path("platform").asText().equals("web") || body.path("type").asInt() != 2 || body.path("protover").asInt() != 2)
          throw new AssertionError("SDK connection handler bypassed normalization");
      } finally { frame.release(); }
    } finally { pipeline.finishAndReleaseAll(); }
    System.out.println("PASS: SDK auth before={platform:null,type:0,protover:1}; after={platform:web,type:2,protover:2,header:1,op:7}; synthetic identity/token/queue and heartbeat preserved.");
  }
}
