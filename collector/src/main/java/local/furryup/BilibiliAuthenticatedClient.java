package local.furryup;

import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelOutboundHandlerAdapter;
import io.netty.channel.ChannelPromise;
import io.netty.channel.socket.SocketChannel;
import tech.ordinaryroad.live.chat.client.bilibili.client.BilibiliLiveChatClient;
import tech.ordinaryroad.live.chat.client.bilibili.config.BilibiliLiveChatClientConfig;
import tech.ordinaryroad.live.chat.client.bilibili.listener.IBilibiliMsgListener;
import tech.ordinaryroad.live.chat.client.codec.bilibili.constant.ProtoverEnum;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.UserAuthenticationMsg;

/** Keep the SDK transport, room resolution, cookie and token flow, but send a
 * complete web-room authentication body. SDK 1.5.8's builder loses platform/type
 * defaults and its connection handler requests protocol 1. See THIRD_PARTY_NOTICES.md.
 */
public class BilibiliAuthenticatedClient extends BilibiliLiveChatClient {
  public BilibiliAuthenticatedClient(BilibiliLiveChatClientConfig config, IBilibiliMsgListener listener) {
    super(config, listener);
  }

  static UserAuthenticationMsg webAuthentication(UserAuthenticationMsg original) {
    // Body protover describes incoming compression; the authentication frame
    // itself is uncompressed. The SDK otherwise conflates these two versions.
    var message = new UserAuthenticationMsg() {
      @Override public ProtoverEnum getProtoverEnum() { return ProtoverEnum.HEARTBEAT_AUTH_NO_COMPRESSION; }
    };
    message.setUid(original.getUid()); message.setRoomid(original.getRoomid());
    message.setBuvid(original.getBuvid()); message.setKey(original.getKey());
    message.setQueue_uuid(original.getQueue_uuid());
    message.setProtover(2); message.setPlatform("web"); message.setType(2);
    message.setSupport_ack(true); message.setScene("room");
    return message;
  }

  static ChannelOutboundHandlerAdapter authenticationHandler() {
    return new ChannelOutboundHandlerAdapter() {
      @Override public void write(ChannelHandlerContext context, Object message, ChannelPromise promise) {
        context.write(message instanceof UserAuthenticationMsg authentication ? webAuthentication(authentication) : message, promise);
      }
    };
  }

  @Override protected void initChannel(SocketChannel channel) {
    super.initChannel(channel);
    // Outbound handlers run tail-to-head: normalize before the SDK encoder.
    channel.pipeline().addLast("furryup-web-auth", authenticationHandler());
  }
}
