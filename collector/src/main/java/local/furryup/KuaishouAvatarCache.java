package local.furryup;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.function.LongSupplier;

/** Reuse only avatars actually supplied for the same Kuaishou room and user ID. */
final class KuaishouAvatarCache {
  private static final long TTL_MS = 30 * 60_000L;
  private static final int MAX_USERS = 2048;
  private record Entry(String url, long expires) {}
  private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>(16, 0.75f, true);
  private final LongSupplier clock;

  KuaishouAvatarCache() { this(System::currentTimeMillis); }
  KuaishouAvatarCache(LongSupplier clock) { this.clock = clock; }

  private static String validAvatar(String value) {
    if (value == null || value.isBlank() || value.length() > 4096
        || value.chars().anyMatch(c -> c <= 32 || c == 127)) return "";
    try {
      URI uri = URI.create(value.startsWith("//") ? "https:" + value : value);
      String scheme = uri.getScheme(), host = uri.getHost();
      if (!("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))
          || host == null || uri.getRawUserInfo() != null
          || (uri.getPort() != -1 && uri.getPort() != ("https".equalsIgnoreCase(scheme) ? 443 : 80))) return "";
      host = host.toLowerCase(Locale.ROOT);
      for (String domain : new String[]{"yximgs.com", "kwimgs.com", "kwaicdn.com", "kwai.net", "wskwai.com"}) {
        if (host.equals(domain) || host.endsWith("." + domain)) return value;
      }
    } catch (IllegalArgumentException ignored) { /* No profile or arbitrary URL lookup. */ }
    return "";
  }

  synchronized String resolve(String room, String userId, String suppliedAvatar) {
    String avatar = validAvatar(suppliedAvatar);
    // Empty/default IDs and nicknames cannot identify an individual viewer.
    if (room == null || room.isBlank() || room.length() > 128
        || userId == null || userId.equals("0") || !userId.matches("[A-Za-z0-9_-]{1,128}")) return avatar;
    long now = clock.getAsLong();
    entries.values().removeIf(entry -> entry.expires() <= now);
    String key = room + '\0' + userId;
    if (!avatar.isEmpty()) {
      entries.put(key, new Entry(avatar, now + TTL_MS));
      while (entries.size() > MAX_USERS) entries.remove(entries.keySet().iterator().next());
      return avatar;
    }
    Entry cached = entries.get(key);
    return cached == null ? "" : cached.url();
  }
}
