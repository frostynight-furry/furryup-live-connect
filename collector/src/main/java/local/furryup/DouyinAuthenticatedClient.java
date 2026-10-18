package local.furryup;

import io.netty.handler.codec.http.DefaultHttpHeaders;
import io.netty.handler.codec.http.websocketx.WebSocketClientProtocolConfig;
import io.netty.handler.codec.http.websocketx.WebSocketClientProtocolHandler;
import io.netty.handler.codec.http.websocketx.WebSocketVersion;
import java.net.URI;
import java.util.LinkedHashMap;
import tech.ordinaryroad.live.chat.client.commons.base.listener.IBaseConnectionListener;
import tech.ordinaryroad.live.chat.client.douyin.client.DouyinLiveChatClient;
import tech.ordinaryroad.live.chat.client.douyin.config.DouyinLiveChatClientConfig;
import tech.ordinaryroad.live.chat.client.douyin.listener.IDouyinMsgListener;
import tech.ordinaryroad.live.chat.client.douyin.netty.handler.DouyinConnectionHandler;

/** Preserve the configured login cookie at the WebSocket handshake (SDK 1.5.8 sends only ttwid).
 * Handshake options follow OrdinaryRoad's MIT-licensed DouyinLiveChatClient; see THIRD_PARTY_NOTICES.md.
 */
public class DouyinAuthenticatedClient extends DouyinLiveChatClient {
  public DouyinAuthenticatedClient(DouyinLiveChatClientConfig config, IDouyinMsgListener listener) {
    super(config, listener);
  }

  static String handshakeCookie(String saved, String ttwid) {
    if (saved == null) saved = "";
    if (saved.length() > 24000 || saved.chars().anyMatch(c -> c < 32 || c == 127))
      throw new IllegalArgumentException("Invalid cookie format");
    var cookies = new LinkedHashMap<String, String>();
    for (String part : saved.split(";")) {
      int split = part.indexOf('=');
      if (split <= 0) continue;
      String name = part.substring(0, split).trim(), value = part.substring(split + 1).trim();
      if (name.matches("[A-Za-z0-9_!#$%&'*+.^`|~-]+")) cookies.put(name, value);
    }
    // The room initialization token takes precedence, without dropping login cookies.
    if (ttwid != null && !ttwid.isBlank()) {
      if (ttwid.chars().anyMatch(c -> c < 33 || c == 127 || c == ';'))
        throw new IllegalArgumentException("Invalid room token");
      cookies.put("ttwid", ttwid);
    }
    return String.join("; ", cookies.entrySet().stream().map(e -> e.getKey() + "=" + e.getValue()).toList());
  }

  static WebSocketClientProtocolConfig handshakeConfig(DouyinLiveChatClientConfig config, URI uri, String ttwid) {
    String host = uri.getHost();
    if (!"wss".equalsIgnoreCase(uri.getScheme()) || host == null ||
        !host.toLowerCase(java.util.Locale.ROOT).endsWith(".douyin.com") || uri.getUserInfo() != null)
      throw new IllegalArgumentException("Invalid Douyin endpoint");
    var headers = new DefaultHttpHeaders();
    headers.set("Cookie", handshakeCookie(config.getCookie(), ttwid));
    headers.set("User-Agent", config.getUserAgent());
    return WebSocketClientProtocolConfig.newBuilder().webSocketUri(uri).version(WebSocketVersion.V13)
      .subprotocol(null).allowExtensions(true).customHeaders(headers)
      .maxFramePayloadLength(config.getMaxFramePayloadLength())
      .handshakeTimeoutMillis(config.getHandshakeTimeoutMillis()).build();
  }

  @Override public DouyinConnectionHandler initConnectionHandler(IBaseConnectionListener<DouyinConnectionHandler> listener) {
    return new DouyinConnectionHandler(() -> new WebSocketClientProtocolHandler(
      handshakeConfig(getConfig(), getWebsocketUri(), roomInitResult.getTtwid())), this, listener);
  }
}
