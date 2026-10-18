package local.furryup;

import java.util.concurrent.atomic.AtomicLong;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.msg.*;
import tech.ordinaryroad.live.chat.client.codec.kuaishou.protobuf.*;

/** Real SDK messages with the empty headUrl observed in live Kuaishou comments. */
public final class KuaishouAvatarFixture {
  private static void check(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }
  private static KuaishouDanmuMsg comment(String id, String userId, String avatar) {
    return new KuaishouDanmuMsg(WebCommentFeedOuterClass.WebCommentFeed.newBuilder().setId(id)
      .setUser(SimpleUserInfoOuterClass.SimpleUserInfo.newBuilder().setPrincipalId(userId)
        .setUserName("相同昵称❄️").setHeadUrl(avatar)).setContent("弹幕没有 headUrl").build());
  }
  private static KuaishouDanmuMsg mysteryComment(String id, String userId, String avatar, long mystery) throws Exception {
    var user = SimpleUserInfoOuterClass.SimpleUserInfo.newBuilder().setPrincipalId(userId)
      .setUserName("相同昵称❄️").setHeadUrl(avatar)
      .setUnknownFields(com.google.protobuf.UnknownFieldSet.newBuilder().addField(4,
        com.google.protobuf.UnknownFieldSet.Field.newBuilder().addVarint(mystery).build()).build());
    var wire = WebCommentFeedOuterClass.WebCommentFeed.newBuilder().setId(id).setUser(user)
      .setContent("平台标记的隐藏身份").build();
    // Decode actual bytes through the old SDK so its unknown-field retention is tested.
    return new KuaishouDanmuMsg(WebCommentFeedOuterClass.WebCommentFeed.parseFrom(wire.toByteArray()));
  }
  public static void main(String[] args) throws Exception {
    var field = Collector.class.getDeclaredField("platform"); field.setAccessible(true); field.set(null, "kuaishou");
    field = Collector.class.getDeclaredField("room"); field.setAccessible(true); field.set(null, "avatar-room");
    String avatar = "https://tx2.a.yximgs.com/uhead/viewer.png";
    check(!Collector.normalizeEvent("onDanmuMsg", comment("before", "viewer", "")).has("avatar_url"), "Never-seen viewer stays avatarless");
    var wire = WebGiftFeedOuterClass.WebGiftFeed.newBuilder().setId("gift-avatar").setGiftId(99992)
      .setUser(SimpleUserInfoOuterClass.SimpleUserInfo.newBuilder().setPrincipalId("viewer")
        .setUserName("相同昵称❄️").setHeadUrl(avatar)).build();
    // Supply a catalog entry to keep this fixture fully offline.
    var apis = tech.ordinaryroad.live.chat.client.codec.kuaishou.api.KuaishouApis.RESULT_CACHE;
    apis.put(tech.ordinaryroad.live.chat.client.codec.kuaishou.api.KuaishouApis.KEY_RESULT_CACHE_GIFT_ITEMS,
      java.util.Map.of("99992", new tech.ordinaryroad.live.chat.client.codec.kuaishou.api.KuaishouApis.GiftInfo("测试礼物", "")));
    check(avatar.equals(Collector.normalizeEvent("onGiftMsg", new KuaishouGiftMsg(wire, 1)).path("avatar_url").asText()), "Gift retains avatar");
    check(avatar.equals(Collector.normalizeEvent("onDanmuMsg", comment("after", "viewer", "")).path("avatar_url").asText()), "Headless comment reuses gift avatar");
    check(!Collector.normalizeEvent("onDanmuMsg", comment("other", "other-viewer", "")).has("avatar_url"), "Same nickname never shares another ID's avatar");
    String changed = "https://tx2.a.kwimgs.com/uhead/new.png";
    check(changed.equals(Collector.normalizeEvent("onDanmuMsg", comment("changed", "viewer", changed)).path("avatar_url").asText()), "Fresh avatar overrides gift cache");
    check(changed.equals(Collector.normalizeEvent("onDanmuMsg", comment("cached-new", "viewer", "")).path("avatar_url").asText()), "New avatar is reused");
    String alternateCdn = "https://p66-live.wskwai.com/uhead/viewer.png";
    check(alternateCdn.equals(Collector.normalizeEvent("onDanmuMsg", comment("alternate-cdn", "viewer", alternateCdn)).path("avatar_url").asText()), "Kuaishou CDN accepted by output proxy is not dropped by collector");
    check(alternateCdn.equals(Collector.normalizeEvent("onDanmuMsg", comment("cached-cdn", "viewer", "")).path("avatar_url").asText()), "Alternate CDN avatar seeds later headless comments");
    var hidden = Collector.normalizeEvent("onDanmuMsg", mysteryComment("mystery", "viewer", "", 1));
    check(hidden.path("user_identity_hidden").asBoolean(), "Official mystery field 4 survives old SDK decoding");
    check(!hidden.has("avatar_url"), "Hidden identity cannot reuse an earlier visible avatar");
    var hiddenSupplied = Collector.normalizeEvent("onDanmuMsg", mysteryComment("mystery-supplied", "hidden-viewer", avatar, 1));
    check(hiddenSupplied.path("user_identity_hidden").asBoolean() && avatar.equals(hiddenSupplied.path("avatar_url").asText()), "Platform-supplied hidden avatar remains message-local");
    check(!Collector.normalizeEvent("onDanmuMsg", comment("after-hidden", "hidden-viewer", "")).has("avatar_url"), "Hidden avatar cannot seed a visible identity cache");
    var visible = Collector.normalizeEvent("onDanmuMsg", mysteryComment("not-mystery", "viewer", "", 0));
    check(!visible.has("user_identity_hidden") && alternateCdn.equals(visible.path("avatar_url").asText()), "Explicit false mystery preserves ordinary identity and cache");
    check(Collector.normalizeEvent("onDanmuMsg", mysteryComment("nonzero-mystery", "other-viewer", "", 2)).path("user_identity_hidden").asBoolean(), "Any nonzero protobuf bool is hidden");
    var outside = Collector.normalizeEvent("onDanmuMsg", comment("outside", "OUTSIDE", avatar));
    check(outside.path("user_identity_hidden").asBoolean(), "Official OUTSIDE sentinel is not a stable user identity");
    check(!Collector.normalizeEvent("onDanmuMsg", comment("outside-next", "OUTSIDE", "")).has("avatar_url"), "Different outside comments never share an avatar");
    var namedMystery = comment("ordinary-nickname", "ordinary-viewer", "");
    namedMystery.setMsg(namedMystery.getMsg().toBuilder().setUser(namedMystery.getMsg().getUser().toBuilder().setUserName("神秘人")).build());
    check(!Collector.normalizeEvent("onDanmuMsg", namedMystery).has("user_identity_hidden"), "Nickname is never treated as an identity privacy flag");
    var hiddenGiftUser = mysteryComment("hidden-gift-user", "hidden-gift-viewer", avatar, 1).getMsg().getUser();
    var hiddenGift = Collector.normalizeEvent("onGiftMsg", new KuaishouGiftMsg(wire.toBuilder()
      .setId("hidden-gift").setUser(hiddenGiftUser).build(), 1));
    check(hiddenGift.path("user_identity_hidden").asBoolean(), "Gift preserves the official mystery flag");
    check(!Collector.normalizeEvent("onDanmuMsg", comment("after-hidden-gift", "hidden-gift-viewer", "")).has("avatar_url"), "Hidden gift avatar cannot seed later visible comments");
    var hiddenLikeUser = mysteryComment("hidden-like-user", "hidden-like-viewer", avatar, 1).getMsg().getUser();
    var hiddenLike = Collector.normalizeEvent("onLikeMsg", new KuaishouLikeMsg(WebLikeFeedOuterClass.WebLikeFeed.newBuilder()
      .setId("hidden-like").setUser(hiddenLikeUser).build()));
    check(hiddenLike.path("user_identity_hidden").asBoolean(), "Like preserves the official mystery flag");
    check(!Collector.normalizeEvent("onDanmuMsg", comment("after-hidden-like", "hidden-like-viewer", "")).has("avatar_url"), "Hidden like avatar cannot seed later visible comments");
    var likeUser = SimpleUserInfoOuterClass.SimpleUserInfo.newBuilder().setPrincipalId("liked-viewer")
      .setUserName("点赞观众").setHeadUrl(avatar).build();
    Collector.normalizeEvent("onLikeMsg", new KuaishouLikeMsg(WebLikeFeedOuterClass.WebLikeFeed.newBuilder()
      .setId("like-avatar").setUser(likeUser).build()));
    check(avatar.equals(Collector.normalizeEvent("onDanmuMsg", comment("after-like", "liked-viewer", "")).path("avatar_url").asText()), "Like avatar can seed later comments");
    field.set(null, "other-room");
    check(!Collector.normalizeEvent("onDanmuMsg", comment("room", "viewer", "")).has("avatar_url"), "Rooms are isolated");
    var clock = new AtomicLong(1000);
    var cache = new KuaishouAvatarCache(clock::get);
    cache.resolve("room", "viewer", avatar);
    clock.addAndGet(29 * 60_000);
    check(avatar.equals(cache.resolve("room", "viewer", "")), "Unexpired entry works");
    clock.addAndGet(60_000);
    check(cache.resolve("room", "viewer", "").isEmpty(), "Fallback does not renew the 30-minute expiry");
    check(cache.resolve("room", "bad", "https://yximgs.com.evil.example/avatar.png").isEmpty(), "Untrusted domain cannot seed cache");
    check(cache.resolve("room", "bad", "https://user@yximgs.com/avatar.png").isEmpty(), "Credentials in URL are rejected");
    cache.resolve("room", "", avatar);
    check(cache.resolve("room", "", "").isEmpty(), "Empty ID cannot share cached avatar");
    for (int i = 0; i < 2049; i++) cache.resolve("room", "user-" + i, avatar);
    check(cache.resolve("room", "user-0", "").isEmpty(), "Cache size is bounded");
    check(avatar.equals(cache.resolve("room", "user-2048", "")), "Recent entry is retained");
    System.err.println("PASS: Kuaishou gift-to-comment avatars, stable IDs, mystery/OUTSIDE identity isolation, fresh avatar precedence, room isolation, URL limits, expiry and bounded cache.");
  }
}
