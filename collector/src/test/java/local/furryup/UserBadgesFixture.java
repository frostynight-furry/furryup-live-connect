package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.protobuf.ByteString;
import com.google.protobuf.UnknownFieldSet;
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
  private static UnknownFieldSet.Field wire(ByteString... values) {
    var field = UnknownFieldSet.Field.newBuilder();
    for (var value : values) field.addLengthDelimited(value);
    return field.build();
  }
  private static ByteString segment(String type, String path, String label) {
    var icon = UnknownFieldSet.newBuilder()
      .addField(1, wire(ByteString.copyFromUtf8("123456")))
      .addField(2, wire(ByteString.copyFromUtf8(path)))
      .addField(4, wire(ByteString.copyFromUtf8(label))).build();
    return UnknownFieldSet.newBuilder().addField(1, wire(icon.toByteString()))
      .addField(3, wire(ByteString.copyFromUtf8(type))).build().toByteString();
  }
  private static ObjectNode modern(int field, int level, ByteString... segments) throws Exception {
    var state = LiveAudienceState.newBuilder().setAssistantTypeValue(1).setWealthGrade(28)
      .setLiveFansGroupState(LiveFansGroupState.newBuilder().setIntimacyLevel(level)).build();
    // Parse the complete wire through the actual old SDK to prove unknown fields survive.
    var wireState = UnknownFieldSet.newBuilder(UnknownFieldSet.parseFrom(state.toByteArray()))
      .addField(field, wire(segments)).build();
    return event("kuaishou", new KuaishouDanmuMsg(WebCommentFeed.newBuilder().setId("synthetic-modern-"+level)
      .setUser(SimpleUserInfo.newBuilder().setPrincipalId("synthetic-user").setUserName("合成粉丝"+level))
      .setSenderState(LiveAudienceState.parseFrom(wireState.toByteArray())).setContent("合成徽章验证").build()));
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
    var screenshotUser = User.newBuilder().setId(456).setNickName("合成房管")
      .setPayGrade(PayGrade.newBuilder().setLevel(20))
      .addBadgeImageList(Image.newBuilder().setContent(ImageContent.newBuilder().setAlternativeText("房管勋章")))
      .addBadgeImageList(Image.newBuilder().setContent(ImageContent.newBuilder().setAlternativeText("荣誉等级20级勋章").setLevel(20)))
      .addBadgeImageList(Image.newBuilder().setContent(ImageContent.newBuilder().setAlternativeText("粉丝团等级11级勋章").setLevel(11)));
    var fixed = event("douyin", new DouyinDanmuMsg(ChatMessage.newBuilder().setUser(screenshotUser).setContent("合成弹幕").build()));
    expect(fixed,"role","管理员",0); expect(fixed,"wealth","荣誉",20); expect(fixed,"fans","粉丝团",11);
    if (fixed.path("user_badges").size()!=3) throw new AssertionError("Image descriptions duplicated badges: "+fixed);
    var screenshotFixed = fixed.deepCopy();
    screenshotUser.setFansClub(FansClub.newBuilder().setData(FansClubData.newBuilder().setClubName("合成团名").setLevel(11)))
      .addBadgeImageList(Image.newBuilder().setContent(ImageContent.newBuilder().setName("管理员徽章").setLevel(1)));
    fixed = event("douyin", new DouyinDanmuMsg(ChatMessage.newBuilder().setUser(screenshotUser).setContent("合成弹幕").build()));
    expect(fixed,"fans","合成团名",11);
    if (fixed.path("user_badges").size()!=3) throw new AssertionError("Prefer structured fans and deduplicate role");
    var fallbackUser=User.newBuilder().addBadgeImageList(Image.newBuilder().setContent(ImageContent.newBuilder().setName("荣誉等级").setLevel(20)))
      .addBadgeImageList(Image.newBuilder().setContent(ImageContent.newBuilder().setAlternativeText("粉丝团等级99999级勋章")))
      .addBadgeImageList(Image.newBuilder().setContent(ImageContent.newBuilder().setName("房管爱好者")));
    fixed=event("douyin",new DouyinDanmuMsg(ChatMessage.newBuilder().setUser(fallbackUser).setContent("合成弹幕").build()));
    expect(fixed,"wealth","荣誉",20); expect(fixed,"title","房管爱好者",0);
    if(fixed.path("user_badges").size()!=2) throw new AssertionError("Unknown title or invalid level misclassified");
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
    var gold = modern(15, 6,
      segment("fansGroup", "super_fans_vip_v_v2/super_fans_vip_6.9.png", "合成团"),
      segment("liveRoomVipState", "super_guardian_level_label/zhong_ai.png", ""),
      segment("honoredGuestState", "keyusers/key_user_honoured_guest.png", ""),
      segment("primeAudience", "prime_audience.png", ""),
      segment("audienceRank", "rank_top/rank_top_1.png", ""));
    expect(gold,"fans","金粉团 · 合成团",6); expect(gold,"membership","钟爱守护",0);
    expect(gold,"membership","贵宾",0); expect(gold,"title","核心观众",0); expect(gold,"title","榜1",0);
    if(gold.path("user_badges").size()!=7) throw new AssertionError("Gold fan label split or missing title: "+gold);
    var diamond = modern(11, 14, segment("fansGroup", "super_fans_svip_v_nian_zuan_v2/super_fans_svip_14.9.png", "合成团"));
    expect(diamond,"fans","钻粉团 · 年费 · 合成团",14);
    if(diamond.path("user_badges").size()!=3) throw new AssertionError("Diamond label split");
    expect(modern(15,6,segment("fansGroup","super_fans_vip_v_nian_v2/super_fans_vip_6.9.png","合成团")),"fans","金粉团 · 年费 · 合成团",6);
    expect(modern(15,14,segment("fansGroup","super_fans_svip_v_zuan_v2/super_fans_svip_14.9.png","合成团")),"fans","钻粉团 · 合成团",14);
    var ordinary = modern(15,6,segment("fansGroup","fans_label_v2/fans_label_6.9.png","合成团"),
      segment("liveRoomVipState","super_guardian_level_label/upcoming_zhong_ai.png",""),
      segment("unknown","keyusers/key_user_honoured_guest.png",""),
      ByteString.copyFrom(new byte[]{10,127}),segment("custom","unknown.png","合成称号"));
    expect(ordinary,"fans","合成团",6); expect(ordinary,"title","合成称号",0);
    if(ordinary.path("user_badges").size()!=4) throw new AssertionError("Unknown or upcoming icon granted identity");
    var authorWins = LiveAudienceState.newBuilder().setFansGroupIntimacyLevel(6).build();
    var both = UnknownFieldSet.newBuilder(UnknownFieldSet.parseFrom(authorWins.toByteArray()))
      .addField(11,wire(segment("fansGroup","fans_label_v2/fans_label_6.9.png","旧团")))
      .addField(15,wire(segment("fansGroup","super_fans_vip_v_v2/super_fans_vip_6.9.png","合成团"))).build();
    var preferred=event("kuaishou",new KuaishouDanmuMsg(WebCommentFeed.newBuilder().setContent("synthetic")
      .setSenderState(LiveAudienceState.parseFrom(both.toByteArray())).build()));
    expect(preferred,"fans","金粉团 · 合成团",6);
    if(preferred.path("user_badges").size()!=1) throw new AssertionError("Author and audience segments duplicated");
    var empty = event("kuaishou", new KuaishouDanmuMsg(WebCommentFeed.newBuilder().setContent("plain").build()));
    if (empty.has("user_badges")) throw new AssertionError("No badges must remain absent");
    if (args.length > 0 && args[0].equals("--emit-events")) for(var e : new ObjectNode[]{b,d,k,screenshotFixed,gold,diamond}) System.out.println(e);
  }
}
