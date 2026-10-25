package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.DanmuMsgMsg;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.DouyinDanmuMsg;
import tech.ordinaryroad.live.chat.client.codec.douyin.protobuf.*;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouDanmuMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.LiveAudienceStateOuterClass.LiveAudienceState;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.LiveFansGroupStateOuterClass.LiveFansGroupState;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.WebCommentFeedOuterClass.WebCommentFeed;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SimpleUserInfoOuterClass.SimpleUserInfo;

public final class UserBadgesFixture {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static ObjectNode event(String platform, Object message) throws Exception {
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, platform);
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "synthetic-room");
    ObjectNode event = Collector.normalizeEvent("onDanmuMsg", message);
    if (event == null) throw new AssertionError("Missing event");
    return event;
  }
  private static void expect(ObjectNode e, String kind, String label, int level) {
    for (var badge : e.path("user_badges")) if (badge.path("kind").asText().equals(kind)
        && badge.path("label").asText().equals(label) && badge.path("level").asInt() == level) return;
    throw new AssertionError("Missing " + kind + "/" + label + "/" + level + " in " + e);
  }
  public static void main(String[] args) throws Exception {
    var bili = new DanmuMsgMsg();
    bili.setInfo(JSON.readTree("[[],\"合成弹幕\",[123,\"合成观众\",1],[14,\"合成粉丝牌\"],[38],[],[],3,[],[],[],[],[],[],[],[],[20]]"));
    var b = event("bilibili", bili);
    expect(b,"role","房管",0); expect(b,"membership","舰长",0); expect(b,"fans","合成粉丝牌",14);
    expect(b,"level","等级",38); expect(b,"wealth","荣耀",20);
    var user = User.newBuilder().setId(123).setNickName("合成观众")
      .setPayGrade(PayGrade.newBuilder().setLevel(38))
      .setFansClub(FansClub.newBuilder().setData(FansClubData.newBuilder().setClubName("合成粉丝团").setLevel(14)))
      .addBadgeImageList(Image.newBuilder().setContent(ImageContent.newBuilder().setName("合成守护"))).build();
    var d = event("douyin", new DouyinDanmuMsg(ChatMessage.newBuilder().setUser(user).setContent("合成弹幕").build()));
    expect(d,"fans","合成粉丝团",14); expect(d,"wealth","荣誉",38); expect(d,"title","合成守护",0);
    var state = LiveAudienceState.newBuilder().setAssistantTypeValue(1).setWealthGrade(38)
      .setLiveFansGroupState(LiveFansGroupState.newBuilder().setIntimacyLevel(300));
    state.addLiveAudienceState11(LiveAudienceState.LiveAudienceState_11.newBuilder().setLiveAudienceState111(
      LiveAudienceState.LiveAudienceState_11.LiveAudienceState_11_1.newBuilder().setBadgeIcon("fans_fixture").setBadgeName("合成团")));
    state.addLiveAudienceState11(LiveAudienceState.LiveAudienceState_11.newBuilder().setLiveAudienceState111(
      LiveAudienceState.LiveAudienceState_11.LiveAudienceState_11_1.newBuilder().setBadgeIcon("guard_fixture").setBadgeName("合成守护")));
    var k = event("kuaishou", new KuaishouDanmuMsg(WebCommentFeed.newBuilder().setId("synthetic")
      .setUser(SimpleUserInfo.newBuilder().setPrincipalId("synthetic-user").setUserName("合成观众"))
      .setSenderState(state).setContent("合成弹幕").build()));
    expect(k,"role","超管",0); expect(k,"wealth","财富",38); expect(k,"fans","合成团",300); expect(k,"title","合成守护",0);
    if (k.path("user_badges").size() != 4) throw new AssertionError("Duplicate or extra badge");
    var empty = event("kuaishou", new KuaishouDanmuMsg(WebCommentFeed.newBuilder().setContent("plain").build()));
    if (empty.has("user_badges")) throw new AssertionError("No badges must remain absent");
    if (args.length > 0 && args[0].equals("--emit-events")) for(var e : new ObjectNode[]{b,d,k}) System.out.println(e);
  }
}
