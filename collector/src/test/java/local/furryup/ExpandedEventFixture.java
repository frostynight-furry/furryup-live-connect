package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import cn.hutool.core.lang.Pair;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import tech.ordinaryroad.live.chat.client.codec.bilibili.api.BilibiliApis;
import tech.ordinaryroad.live.chat.client.codec.bilibili.api.response.RoomPlayInfoResult;
import tech.ordinaryroad.live.chat.client.codec.bilibili.constant.BilibiliLiveStatusEnum;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.*;
import tech.ordinaryroad.live.chat.client.codec.bilibili.room.BilibiliRoomInitResult;
import tech.ordinaryroad.live.chat.client.codec.douyin.constant.DouyinRoomStatusEnum;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.*;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.*;
import tech.ordinaryroad.live.chat.client.codec.douyin.room.DouyinRoomInitResult;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouRoomStatsMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.room.KuaishouRoomInitResult;

/** Offline assertions for additional OrdinaryRoad callbacks and optional fields. */
public final class ExpandedEventFixture {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final List<ObjectNode> SAMPLES = new ArrayList<>();
  private static void platform(String name) throws Exception {
    Field field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, name);
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "fixture-room");
  }
  private static ObjectNode event(String callback, Object message, String type) {
    ObjectNode result = Collector.normalizeEvent(callback, message);
    if (result == null || !type.equals(result.path("event_type").asText()))
      throw new AssertionError("Missing " + type + " from " + callback);
    SAMPLES.add(result);
    return result;
  }
  private static void field(ObjectNode result, String key, String expected) {
    if (!expected.equals(result.path(key).asText()))
      throw new AssertionError(key + ": " + result.path(key) + " != " + expected);
  }
  private static void absent(ObjectNode result, String key) {
    if (result.has(key)) throw new AssertionError("Unexpected " + key + " in " + result);
  }
  public static void main(String[] args) throws Exception {
    System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8));
    platform("bilibili");
    var wordData = new InteractWordMsg.Data();
    wordData.setUid(123); wordData.setUname("B站观众");
    var medal = new InteractWordMsg.Fans_medal(); medal.setMedal_name("粉丝牌"); medal.setMedal_level((byte) 7);
    wordData.setFans_medal(medal);
    wordData.setMsg_type(1);
    ObjectNode enter = event("onEnterRoomMsg", new InteractWordMsg(wordData), "enter");
    field(enter, "badge_name", "粉丝牌"); field(enter, "badge_level", "7");
    wordData.setMsg_type(2); event("onEnterRoomMsg", new InteractWordMsg(wordData), "follow");
    wordData.setMsg_type(3); event("onEnterRoomMsg", new InteractWordMsg(wordData), "share");
    wordData.setMsg_type(4);
    if (Collector.normalizeEvent("onEnterRoomMsg", new InteractWordMsg(wordData)) != null)
      throw new AssertionError("Bilibili special-interaction must not become entry");

    var scData = new SuperChatMessageMsg.Data();
    scData.setId(80); scData.setUid(123); scData.setMessage("醒目留言"); scData.setPrice(30); scData.setTime(60);
    var scUser = new SuperChatMessageMsg.User_info(); scUser.setUname("B站观众"); scData.setUser_info(scUser);
    ObjectNode sc = event("onSuperChatMsg", new SuperChatMessageMsg(1, scData), "super_chat");
    field(sc, "super_chat_price_raw", "30"); field(sc, "super_chat_price_unit", "cny");
    field(sc, "super_chat_duration", "60"); field(sc, "source_msg_id", "bili-super-chat:80");

    var giftData = new SendGiftMsg.Data();
    giftData.setUid(123); giftData.setUname("B站观众"); giftData.setGiftId(1); giftData.setGiftName("礼物");
    giftData.setNum(1); giftData.setPrice(1000); giftData.setCoin_type("gold"); giftData.setBatch_combo_id("combo-b");
    var recipient = new SendGiftMsg.Receive_user_info(); recipient.setUid(456); recipient.setUname("主播");
    giftData.setReceive_user_info(recipient);
    ObjectNode gift = event("onGiftMsg", new SendGiftMsg(giftData, 0), "gift");
    field(gift, "gift_price_raw", "1000"); field(gift, "gift_price_unit", "bilibili_coin");
    field(gift, "gift_coin_type", "gold"); field(gift, "combo_id", "combo-b");
    field(gift, "receive_user_id", "456");

    var stats = new BilibiliRoomStatsMsg(JSON.readTree("{\"online_count\":12}"));
    stats.setCmd("ONLINE_RANK_COUNT"); field(event("onRoomStatsMsg", stats, "room_stats"), "watching_count", "12");
    stats.setCmd("WATCHED_CHANGE"); stats.setData(JSON.readTree("{\"num\":345}"));
    field(event("onRoomStatsMsg", stats, "room_stats"), "watched_count", "345");
    stats.setCmd("LIKE_INFO_V3_UPDATE"); stats.setData(JSON.readTree("{\"click_count\":67}"));
    field(event("onRoomStatsMsg", stats, "room_stats"), "liked_count", "67");
    stats.setData(JSON.readTree("{}"));
    if (Collector.normalizeEvent("onRoomStatsMsg", stats) != null) throw new AssertionError("Empty room stats");

    var status = new BilibiliLiveStatusChangeMsg(); status.setCmd("LIVE");
    field(event("onLiveStatusMsg", status, "live_status"), "live_status", "started");
    status.setCmd("STOP_LIVE_ROOM_LIST"); status.setRoomIdPair(Pair.of(100L, 0L));
    status.setData(JSON.readTree("{\"room_id_list\":[100]}"));
    field(event("onLiveStatusMsg", status, "live_status"), "live_status", "ended");
    status.setData(JSON.readTree("{\"room_id_list\":[999]}"));
    if (Collector.normalizeEvent("onLiveStatusMsg", status) != null) throw new AssertionError("Unrelated live status");
    var effect = new MessageMsg(); effect.setData(JSON.readTree("{\"uid\":123,\"copy_writing\":\"欢迎入场\"}"));
    field(event("onEntryEffect", effect, "entry_effect"), "content", "欢迎入场");
    var bRoom = new BilibiliRoomInitResult();
    var bRoomDetails = new BilibiliApis.RoomByIds(); bRoomDetails.setTitle("B站直播"); bRoom.setRoomByIds(bRoomDetails);
    var bPlayInfo = new RoomPlayInfoResult(); bPlayInfo.setLive_status(BilibiliLiveStatusEnum.LIVING);
    bRoom.setRoomPlayInfoResult(bPlayInfo);
    ObjectNode bInfo = Collector.normalizeRoomInfo(bRoom, "");
    field(bInfo, "room_title", "B站直播"); field(bInfo, "room_live_status", "started");
    absent(bInfo, "room_description");

    platform("douyin");
    var user = User.newBuilder().setId(987).setNickName("抖音观众").build();
    event("onEnterRoomMsg", new DouyinEnterRoomMsg(MemberMessage.newBuilder().setUser(user).build()), "enter");
    event("onSocialMsg", new DouyinSocialMsg(SocialMessage.newBuilder().setUser(user).setAction(1).build()), "follow");
    event("onSocialMsg", new DouyinSocialMsg(SocialMessage.newBuilder().setUser(user).setAction(3).build()), "share");
    if (Collector.normalizeEvent("onSocialMsg", new DouyinSocialMsg(SocialMessage.newBuilder().setUser(user).setAction(9).build())) != null)
      throw new AssertionError("Unknown social action");
    field(event("onLiveStatusMsg", new DouyinControlMsg(ControlMessage.newBuilder().setStatus(3).build()), "live_status"), "live_status", "ended");
    if (Collector.normalizeEvent("onLiveStatusMsg", new DouyinControlMsg(ControlMessage.newBuilder().setStatus(1).build())) != null)
      throw new AssertionError("Douyin status 1 must not be called started");
    field(event("onRoomStatsMsg", new DouyinRoomStatsMsg("77", RoomStatsMessage.newBuilder().setTotal(55).build()), "room_stats"), "watching_count", "55");
    var dyGiftWire = GiftMessage.newBuilder().setUser(user).setToUser(User.newBuilder().setId(456).setNickName("主播"))
      .setGiftId(8).setGift(GiftStruct.newBuilder().setName("心").setDiamondCount(2))
      .setGroupId(999).setRepeatCount(1).build();
    ObjectNode dyGift = event("onGiftMsg", new DouyinGiftMsg(dyGiftWire, 1), "gift");
    field(dyGift, "gift_price_raw", "2"); field(dyGift, "gift_price_unit", "diamond");
    field(dyGift, "combo_id", "999"); field(dyGift, "receive_user_id", "456");
    var dyNoPrice = GiftMessage.newBuilder().setUser(user).setGiftId(9).setGift(GiftStruct.newBuilder().setName("免费礼物")).build();
    ObjectNode noPrice = event("onGiftMsg", new DouyinGiftMsg(dyNoPrice, 1), "gift");
    absent(noPrice, "gift_price_raw"); absent(noPrice, "receive_user_id");

    var room = new DouyinRoomInitResult();
    room.setRoomInfoJsonNode(JSON.readTree("{\"room\":{\"title\":\"抖音直播\",\"description\":\"房间简介\"}}"));
    room.setRoomStatus(DouyinRoomStatusEnum.LIVING);
    ObjectNode info = Collector.normalizeRoomInfo(room, room.getRoomInfoJsonNode().path("room").path("description").asText());
    field(info, "room_title", "抖音直播"); field(info, "room_description", "房间简介");
    field(info, "room_live_status", "started");

    platform("kuaishou");
    ObjectNode ksStats = event("onRoomStatsMsg", new KuaishouRoomStatsMsg("22", "33"), "room_stats");
    field(ksStats, "liked_count", "22"); field(ksStats, "watching_count", "33");
    var ksRoom = new KuaishouRoomInitResult();
    ksRoom.setLivedetailJsonNode(JSON.readTree("{\"author\":{\"name\":\"快手直播\",\"description\":\"快手简介\"},\"liveStream\":{\"id\":\"fixture\"}}"));
    ObjectNode ksInfo = Collector.normalizeRoomInfo(ksRoom, ksRoom.getRoomDescription());
    field(ksInfo, "room_title", "快手直播"); field(ksInfo, "room_description", "快手简介");
    field(ksInfo, "room_live_status", "started");
    if (args.length > 0 && args[0].equals("--emit")) {
      for (ObjectNode sample : SAMPLES)
        System.out.println(JSON.createObjectNode().put("kind", "event").set("event", sample));
      for (ObjectNode sample : List.of(bInfo, info, ksInfo)) System.out.println(sample);
    } else System.out.println("ExpandedEventFixture ok");
  }
}
