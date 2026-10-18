package local.furryup;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.DanmuMsgMsg;
import tech.ordinaryroad.live.chat.client.codec.douyin.msg.DouyinDanmuMsg;

/** Keep only explicit text-to-image mappings supplied by the message. */
final class MessageEmotes {
  private static final ObjectMapper JSON = new ObjectMapper();
  static ArrayNode extract(Object message, String content) {
    ArrayNode result = JSON.createArrayNode();
    try {
      if (message instanceof DanmuMsgMsg bili) {
        JsonNode head = bili.getInfo().path(0);
        add(result, content, content, head.path(13).path("url").asText());
        JsonNode extra = head.path(15).path("extra");
        if (extra.isTextual() && extra.asText().length() <= 131072) extra = JSON.readTree(extra.asText());
        if (extra != null && extra.path("emots").isObject()) {
          var fields = extra.path("emots").fields();
          while (fields.hasNext() && result.size() < 32) {
            var field = fields.next();
            add(result, content, field.getKey(), field.getValue().path("url").asText());
          }
        }
      } else if (message instanceof DouyinDanmuMsg douyin) {
        for (var piece : douyin.getMsg().getRtfContent().getPiecesList()) {
          if (!piece.hasImagevalue()) continue;
          var image = piece.getImagevalue().getImage();
          if (image.getUrlListListCount() == 0) continue;
          String token = image.getContent().getAlternativeText();
          if (token.isBlank()) token = image.getContent().getName();
          if (token.isBlank()) token = piece.getStringValue();
          add(result, content, token, image.getUrlListList(0));
        }
      }
    } catch (Exception ignored) { /* A missing or changed metadata field never drops chat text. */ }
    return result;
  }
  private static void add(ArrayNode result, String content, String token, String url) {
    if (result.size() >= 32 || token.isBlank() || token.length() > 80 || !content.contains(token) || url.isBlank() || url.length() > 4096) return;
    for (JsonNode item : result) if (item.path("token").asText().equals(token)) return;
    result.addObject().put("token", token).put("url", url);
  }
  static void selfTest() throws Exception {
    var message = new DanmuMsgMsg();
    var info = JSON.createArrayNode(); var head = info.addArray();
    for (int i = 0; i < 16; i++) head.addNull();
    var extra = JSON.createObjectNode(); extra.putObject("emots").putObject("[dog]").put("url", "https://i0.hdslb.com/dog.png");
    head.set(15, JSON.createObjectNode().put("extra", extra.toString()));
    message.setInfo(info);
    if (extract(message, "你好[dog][dog]").size() != 1) throw new AssertionError("Bilibili inline emotes");
    head.set(13, JSON.createObjectNode().put("url", "https://i0.hdslb.com/large.png"));
    if (!extract(message, "[大表情]").get(0).path("token").asText().equals("[大表情]")) throw new AssertionError("Bilibili full-message emote");
    head.set(13, JSON.createObjectNode()); head.set(15, JSON.createObjectNode().put("extra", "malformed"));
    if (!extract(message, "hello").isEmpty()) throw new AssertionError("Invalid emotes must leave text intact");
  }
}
