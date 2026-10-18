package local.furryup;

import java.io.*;
import java.util.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.protobuf.CodedOutputStream;
import cn.hutool.core.lang.Pair;
import tech.ordinaryroad.live.chat.client.bilibili.listener.IBilibiliMsgListener;
import tech.ordinaryroad.live.chat.client.bilibili.netty.handler.BilibiliBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.codec.bilibili.constant.BilibiliCmdEnum;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.MessageMsg;
import tech.ordinaryroad.live.chat.client.douyin.listener.IDouyinMsgListener;
import tech.ordinaryroad.live.chat.client.douyin.netty.handler.DouyinBinaryFrameHandler;
import tech.ordinaryroad.live.chat.client.codec.douyin.api.DouyinApis;
import tech.ordinaryroad.live.chat.client.codec.douyin.constant.*;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.*;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.*;

/** Synthetic wire fixtures using the SDK parser and production listener; never opens a connection. */
public final class PlatformEventFixture {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static void platform(String value) throws Exception {
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, value);
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
  }
  private static void bili(BilibiliBinaryFrameHandler handler, String cmd, String data) throws Exception {
    // Exercise the SDK's binary framing and JSON decoding before dispatching the gift.
    byte[] body = JSON.createObjectNode().put("cmd",cmd).set("data",JSON.readTree(data)).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
    var frame=io.netty.buffer.Unpooled.buffer(16+body.length);
    frame.writeInt(16+body.length).writeShort(16).writeShort(0).writeInt(5).writeInt(1).writeBytes(body);
    MessageMsg msg;
    try { msg=(MessageMsg)tech.ordinaryroad.live.chat.client.codec.bilibili.util.BilibiliCodecUtil.decode(frame).getFirst(); }
    finally { frame.release(); }
    handler.onCmdMsg(BilibiliCmdEnum.valueOf(cmd), msg);
  }
  private static byte[] item(int id, String name, int count, String tid) throws Exception {
    var bytes = new ByteArrayOutputStream(); var out = CodedOutputStream.newInstance(bytes);
    out.writeInt64(1, id); out.writeString(2, name); out.writeInt32(3, count);
    if (tid != null) out.writeString(9, tid);
    out.writeInt64(10, 1700000000L); out.writeString(99, "future field"); out.flush(); return bytes.toByteArray();
  }
  private static String batch(byte[]... items) throws Exception {
    var bytes = new ByteArrayOutputStream(); var out = CodedOutputStream.newInstance(bytes);
    out.writeInt64(1, 12345); out.writeString(2, "B站观众❄️"); out.writeString(3, "https://i0.hdslb.com/fixture.png");
    for (var item : items) out.writeByteArray(10, item);
    out.flush(); return JSON.createObjectNode().put("pb", Base64.getEncoder().encodeToString(bytes.toByteArray())).toString();
  }
  public static void main(String[] args) throws Exception {
    platform("bilibili");
    System.setOut(new PrintStream(OutputStream.nullOutputStream()));
    System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    var handler = new BilibiliBinaryFrameHandler(List.of(Collector.listener(IBilibiliMsgListener.class)), 1L, Pair.of(1L, 0L));
    bili(handler, "SEND_GIFT", "{\"uid\":12345,\"uname\":\"B站观众❄️\",\"giftId\":1,\"giftName\":\"辣条\",\"num\":2,\"tid\":\"shared-transaction\",\"face\":\"https://i0.hdslb.com/fixture.png\"}");
    String batch = batch(item(1,"辣条",2,"shared-transaction"), item(2,"鲜花",3,"shared-transaction"));
    bili(handler, "SEND_GIFT_V2", batch); bili(handler, "SEND_GIFT_V2", batch);
    bili(handler, "SEND_GIFT_V2", "{\"data\":"+batch+"}"); // Nested envelope must decode and deduplicate identically.
    String noId = batch(item(3,"牛蛙🐸",1,null));
    bili(handler,"SEND_GIFT_V2",noId); bili(handler,"SEND_GIFT_V2",noId);
    bili(handler,"SEND_GIFT_V2",batch(item(4,"无效数量",0,null)));
    bili(handler,"SEND_GIFT_V2","{\"pb\":\"invalid!\"}");
    bili(handler,"SEND_GIFT_V2","{\"pb\":\"UgUJ\"}"); // truncated nested message
    bili(handler,"COMBO_SEND","{}"); // summary must not double-count gifts
    bili(handler,"LIKE_INFO_V3_CLICK","{\"uid\":12345,\"uname\":\"B站观众❄️\",\"like_text\":\"为主播点赞了\"}");
    MessageMsg comment = new MessageMsg(); comment.setCmd("DANMU_MSG");
    comment.setInfo(JSON.readTree("[[],\"B站弹幕🎁\",[12345,\"B站观众❄️\"],[]]"));
    handler.onCmdMsg(BilibiliCmdEnum.DANMU_MSG, comment);
    // Decoder input limits and empty batches.
    if (!BilibiliGiftV2.decode(JSON.readTree(batch()).get("pb").asText()).isEmpty()) throw new AssertionError("empty batch");
    try { BilibiliGiftV2.decode("A".repeat(512*1024+1)); throw new AssertionError("size limit"); } catch (IOException expected) { }
    for(String invalid : new String[]{"null", "{}", "{\"pb\":123}", "{\"data\":{\"pb\":[]}}"}) {
      try { BilibiliGiftV2.decodeData(JSON.readTree(invalid)); throw new AssertionError("invalid envelope"); } catch(IOException expected) { }
    }
    if(BilibiliGiftV2.decodeData(JSON.readTree("{\"pb\":null,\"data\":"+batch+"}")).size()!=2)throw new AssertionError("nested fallback");
    byte[][] tooMany = new byte[129][]; Arrays.fill(tooMany,item(1,"礼物",1,null));
    try { BilibiliGiftV2.decode(JSON.readTree(batch(tooMany)).get("pb").asText()); throw new AssertionError("batch limit"); } catch (IOException expected) { }

    platform("douyin");
    var listener = Collector.listener(IDouyinMsgListener.class);
    var dy = new DouyinBinaryFrameHandler(List.of(listener), 1L);
    var user = User.newBuilder().setId(12345).setNickName("抖音观众❄️")
      .setAvatarThumb(Image.newBuilder().addUrlListList("https://p3.douyinpic.com/fixture.png")).build();
    var chat = ChatMessage.newBuilder().setCommon(Common.newBuilder().setMsgId(1001)).setUser(user).setContent("抖音弹幕🎁").build();
    dy.onCmdMsg(DouyinCmdEnum.WebcastChatMessage, new DouyinCmdMsg(Message.newBuilder().setMethod("WebcastChatMessage").setPayload(chat.toByteString()).build()));
    var like = LikeMessage.newBuilder().setCommon(Common.newBuilder().setMsgId(1002)).setUser(user).setCount(7).setTotal(999).build();
    var likeCmd = new DouyinCmdMsg(Message.newBuilder().setMethod("WebcastLikeMessage").setPayload(like.toByteString()).build());
    dy.onCmdMsg(DouyinCmdEnum.WebcastLikeMessage, likeCmd); dy.onCmdMsg(DouyinCmdEnum.WebcastLikeMessage, likeCmd);
    int index=0;
    for (int count : new int[]{1,3,3,2,4}) {
      var wire = GiftMessage.newBuilder().setCommon(Common.newBuilder().setMsgId(1100+index++))
        .setUser(user).setGiftId(99).setGift(GiftStruct.newBuilder().setName("小心心💗").setCombo(true))
        .setGroupId(5001).setRepeatCount(count).setGroupCount(1).setComboCount(count).build();
      var gift = new DouyinGiftMsg(GiftMessage.parseFrom(wire.toByteArray()));
      // Same SDK calculation used by handler; no live client required for the offline gift case.
      DouyinApis.calculateGiftCount(gift, DouyinGiftCountCalculationTimeEnum.IMMEDIATELY);
      listener.onGiftMsg(dy, gift);
    }
    CollectorWireFixture.main(args);
    System.exit(0);
  }
}
