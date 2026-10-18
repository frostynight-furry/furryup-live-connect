package local.furryup;

import java.io.OutputStream;
import java.io.PrintStream;
import java.util.Map;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.api.KuaishouApis;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.*;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.*;

/** Offline SDK fixtures, exercising the actual collector stdout protocol. No platform requests. */
public final class CollectorWireFixture {
  public static void main(String[] args) throws Exception {
    // Initialize the collector's protocol output before suppressing dependency logs, like main().
    var platform = Collector.class.getDeclaredField("platform"); platform.setAccessible(true); platform.set(null, "kuaishou");
    var room = Collector.class.getDeclaredField("room"); room.setAccessible(true); room.set(null, "fixture-room");
    System.setOut(new PrintStream(OutputStream.nullOutputStream()));
    System.setErr(new PrintStream(OutputStream.nullOutputStream()));
    var user = SimpleUserInfoOuterClass.SimpleUserInfo.newBuilder().setPrincipalId("fixture-user").setUserName("测试观众·雪❄️🐾").setHeadUrl("https://tx2.a.yximgs.com/uhead/fixture.png").build();
    // Test-only catalog entries never ship in the collector jar.
    KuaishouApis.RESULT_CACHE.put(KuaishouApis.KEY_RESULT_CACHE_GIFT_ITEMS, Map.of("99991", new KuaishouApis.GiftInfo("测试礼物·盛典票🌟", "")));
    for (int count : new int[]{1, 3, 3}) {
      var wire = WebGiftFeedOuterClass.WebGiftFeed.newBuilder().setId("gift-" + count).setUser(user)
        .setGiftId(99991).setMergeKey("fixture-combo").setBatchSize(1).setComboCount(count).build();
      var gift = new KuaishouGiftMsg(wire);
      KuaishouApis.calculateGiftCount(gift);
      Collector.event("onGiftMsg", gift);
    }
    var unknown = new KuaishouGiftMsg(WebGiftFeedOuterClass.WebGiftFeed.newBuilder().setId("unknown-gift").setUser(user)
      .setGiftId(99992).setMergeKey("fixture-unknown").setBatchSize(1).setComboCount(1).build());
    KuaishouApis.calculateGiftCount(unknown);
    Collector.event("onGiftMsg", unknown);
    Collector.event("onLikeMsg", new KuaishouLikeMsg(WebLikeFeedOuterClass.WebLikeFeed.newBuilder().setId("like-1").setUser(user).build()));
    Collector.event("onDanmuMsg", new KuaishouDanmuMsg(WebCommentFeedOuterClass.WebCommentFeed.newBuilder().setId("chat-1").setUser(user).setContent("中文弹幕 / English / 🎁 雪花❄️").build()));
  }
}
