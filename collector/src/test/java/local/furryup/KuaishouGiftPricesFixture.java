package local.furryup;

import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.api.KuaishouApis;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.KuaishouGiftMsg;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.WebGiftFeedOuterClass;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.SimpleUserInfoOuterClass;

/** Synthetic price and SDK wire fixtures. Optional live probe only reads a supplied stream's catalog. */
public final class KuaishouGiftPricesFixture {
  static final String CATALOG = "{\"data\":{\"gifts\":[{\"id\":12862,\"name\":\"姻缘树\",\"unitPrice\":1000},{\"id\":114,\"unitPrice\":1}]}}";
  static void check(boolean ok) { if (!ok) throw new AssertionError("Gift price fixture failed"); }
  public static void main(String[] args) throws Exception {
    if (args.length == 2 && args[0].equals("--live-stream")) {
      try (var live = new KuaishouGiftPrices(ignored -> {})) {
        live.start(args[1], "", false);
        System.out.println("{\"gift\":\"姻缘树\",\"price\":" + live.price("12862") + ",\"unit\":\"kuaibi\"}");
      }
      return;
    }
    var clock = new AtomicLong(1000); var calls = new AtomicInteger(); var metrics = new ArrayList<String>();
    try (var prices = new KuaishouGiftPrices((url,cookie) -> { check(url.endsWith("liveStreamId=fixture-stream")); calls.incrementAndGet(); return CATALOG; }, clock::get, metrics::add)) {
      prices.start("fixture-stream", "", false); check(calls.get() == 1); check(prices.price("12862") == 1000); check(prices.price("missing") == null);
      prices.start("fixture-stream", "", true); check(calls.get() == 1);
      clock.addAndGet(KuaishouGiftPrices.TTL_MS); check(prices.price("12862") == null); check(prices.refresh()); check(prices.price("12862") == 1000);
      prices.acceptCatalog("{\"data\":{\"gifts\":[{\"id\":1,\"unitPrice\":1000},{\"id\":1,\"unitPrice\":999},{\"id\":2,\"virtualPrice\":1000},{\"id\":3,\"unitPrice\":\"1000\"},{\"id\":4,\"unitPrice\":1}]}}");
      check(prices.price("1") == null && prices.price("2") == null && prices.price("3") == null && prices.price("4") == 1);
    }
    var restrictedCalls = new AtomicInteger();
    try (var restricted = new KuaishouGiftPrices((url,cookie)->{restrictedCalls.incrementAndGet();return "{\"data\":{\"result\":2}}";},clock::get,ignored->{})) {
      restricted.start("fixture-stream","",false); for(int i=0;i<5;i++) restricted.refresh(); check(restrictedCalls.get()==1); check(restricted.price("12862")==null);
    }
    var failedCalls = new AtomicInteger();
    try(var failed = new KuaishouGiftPrices((url,cookie)->{failedCalls.incrementAndGet();throw new Exception("offline");},clock::get,ignored->{})) {
      failed.start("fixture-stream","",false);for(int i=0;i<5;i++)failed.refresh();check(failedCalls.get()==3);
    }
    var field = Collector.class.getDeclaredField("KUAISHOU_GIFT_PRICES");field.setAccessible(true);
    ((KuaishouGiftPrices)field.get(null)).acceptCatalog(CATALOG);
    field=Collector.class.getDeclaredField("platform");field.setAccessible(true);field.set(null,"kuaishou");
    field=Collector.class.getDeclaredField("room");field.setAccessible(true);field.set(null,"fixture-room");
    KuaishouApis.RESULT_CACHE.put(KuaishouApis.KEY_RESULT_CACHE_GIFT_ITEMS,Map.of("12862",new KuaishouApis.GiftInfo("姻缘树","")));
    var user=SimpleUserInfoOuterClass.SimpleUserInfo.newBuilder().setPrincipalId("fixture-user").setUserName("测试观众").build();
    var gift=new KuaishouGiftMsg(WebGiftFeedOuterClass.WebGiftFeed.newBuilder().setGiftId(12862).setUser(user).setMergeKey("price-fixture").setBatchSize(2).setComboCount(2).build());
    KuaishouApis.calculateGiftCount(gift);
    var normalized=Collector.normalizeEvent("onGiftMsg",gift);
    check(normalized.path("gift_count").asInt()==2);check(normalized.path("gift_price_raw").asLong()==1000);check(normalized.path("gift_price_unit").asText().equals("kuaibi"));
    if(args.length==1 && args[0].equals("--emit-event")) System.out.println(normalized);
    else System.out.println("PASS Kuaishou prices: exact unit metadata, missing/conflicting prices, TTL, bounded failure, restrictions, actual SDK wire");
  }
}
