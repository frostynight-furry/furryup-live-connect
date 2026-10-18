package local.furryup;
import java.net.URI;
import tech.ordinaryroad.live.chat.client.douyin.config.DouyinLiveChatClientConfig;
public final class DouyinHandshakeFixture {
  static void check(boolean value) { if (!value) throw new AssertionError("Douyin handshake regression"); }
  public static void main(String[] args) {
    var config = DouyinLiveChatClientConfig.builder().cookie("sessionid=fake-session; sessionid_ss=fake-ss; ttwid=old; other=a=b").build();
    var handshake = DouyinAuthenticatedClient.handshakeConfig(config, URI.create("wss://webcast5-ws-web-lq.douyin.com/webcast/im/push/v2/"), "fresh");
    String cookie = handshake.customHeaders().get("Cookie");
    check(cookie.contains("sessionid=fake-session") && cookie.contains("sessionid_ss=fake-ss"));
    check(cookie.contains("other=a=b") && cookie.contains("ttwid=fresh") && !cookie.contains("ttwid=old"));
    check(handshake.customHeaders().getAll("Cookie").size() == 1);
    check(handshake.maxFramePayloadLength() == config.getMaxFramePayloadLength());
    check(DouyinAuthenticatedClient.handshakeCookie("", "guest").equals("ttwid=guest"));
    check(DouyinAuthenticatedClient.handshakeCookie(null, null).isEmpty());
    for (String invalid : new String[]{"sessionid=a\r\nX-Leak: b", "x=\u0000", "x="+"a".repeat(24000)}) {
      try { DouyinAuthenticatedClient.handshakeCookie(invalid, "guest"); throw new AssertionError("Accepted invalid cookie"); }
      catch (IllegalArgumentException expected) { }
    }
    for (String invalid : new String[]{"wss://douyin.com.attacker.test/ws", "wss://attacker.test/ws", "ws://webcast5-ws-web-lq.douyin.com/ws"}) {
      try { DouyinAuthenticatedClient.handshakeConfig(config, URI.create(invalid), "guest"); throw new AssertionError("Leaked cookie endpoint"); }
      catch (IllegalArgumentException expected) { }
    }
    System.out.println("Douyin handshake regression passed");
  }
}
