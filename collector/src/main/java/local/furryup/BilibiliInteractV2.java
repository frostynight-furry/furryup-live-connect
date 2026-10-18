package local.furryup;

import com.fasterxml.jackson.databind.JsonNode;
import com.google.protobuf.CodedInputStream;
import java.io.IOException;
import java.util.Base64;
import tech.ordinaryroad.live.chat.client.codec.bilibili.msg.InteractWordMsg;

/** INTERACT_WORD_V2 field layout documented by blivedm (MIT); see THIRD_PARTY_NOTICES.md. */
final class BilibiliInteractV2 {
  static InteractWordMsg decodeData(JsonNode data) throws IOException {
    if (data == null || !data.isObject()) throw new IOException("Missing interaction data");
    JsonNode pb = data.path("pb");
    if (pb.isMissingNode() || pb.isNull() || (pb.isTextual() && pb.asText().isBlank()))
      pb = data.path("data").path("pb");
    if (!pb.isTextual()) throw new IOException("Missing interaction protobuf");
    return decode(pb.asText());
  }

  static InteractWordMsg decode(String encoded) throws IOException {
    if (encoded == null || encoded.isBlank() || encoded.length() > 512 * 1024)
      throw new IOException("Invalid interaction payload size");
    final byte[] bytes;
    try { bytes = Base64.getDecoder().decode(encoded); }
    catch (IllegalArgumentException error) { throw new IOException("Invalid interaction encoding"); }
    CodedInputStream input = CodedInputStream.newInstance(bytes);
    input.setRecursionLimit(16);
    InteractWordMsg.Data data = new InteractWordMsg.Data();
    for (int tag; (tag = input.readTag()) != 0;) {
      switch (tag) {
        case 8 -> data.setUid(input.readInt64());
        case 18 -> data.setUname(input.readStringRequireUtf8());
        case 40 -> data.setMsg_type(input.readInt32());
        case 56 -> data.setTimestamp(input.readInt64());
        case 178 -> data.setUinfo(readUser(input.readByteArray()));
        default -> { if (!input.skipField(tag)) throw new IOException("Unexpected interaction group"); }
      }
    }
    return new InteractWordMsg(data);
  }

  private static InteractWordMsg.Uinfo readUser(byte[] bytes) throws IOException {
    CodedInputStream input = CodedInputStream.newInstance(bytes);
    input.setRecursionLimit(16);
    InteractWordMsg.Uinfo user = new InteractWordMsg.Uinfo();
    for (int tag; (tag = input.readTag()) != 0;) {
      if (tag == 18) user.setBase(readBase(input.readByteArray()));
      else if (!input.skipField(tag)) throw new IOException("Unexpected interaction user group");
    }
    return user;
  }

  private static InteractWordMsg.Base readBase(byte[] bytes) throws IOException {
    CodedInputStream input = CodedInputStream.newInstance(bytes);
    input.setRecursionLimit(16);
    InteractWordMsg.Base base = new InteractWordMsg.Base();
    for (int tag; (tag = input.readTag()) != 0;) {
      if (tag == 18) base.setFace(input.readStringRequireUtf8());
      else if (!input.skipField(tag)) throw new IOException("Unexpected interaction base group");
    }
    return base;
  }
}
