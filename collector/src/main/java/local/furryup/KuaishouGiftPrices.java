package local.furryup;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** Read-only price supplement for OrdinaryRoad 1.5.8's zero-valued Kuaishou getter. */
final class KuaishouGiftPrices implements AutoCloseable {
  static final long TTL_MS = 5 * 60_000L;
  static final int MAX_BYTES = 4 * 1024 * 1024;
  private static final ObjectMapper JSON = new ObjectMapper();
  interface Fetch { String get(String url, String cookie) throws Exception; }
  private final Fetch fetch;
  private final LongSupplier now;
  private final Consumer<String> diagnostic;
  private volatile Map<String, Long> prices = Map.of();
  private volatile long expiresAt;
  private volatile boolean closed, suspended;
  private String streamId = "", cookie = "";
  private int failures;
  private volatile ScheduledExecutorService scheduler;
  private boolean started;

  KuaishouGiftPrices(Consumer<String> diagnostic) { this(KuaishouGiftPrices::request, System::currentTimeMillis, diagnostic); }
  KuaishouGiftPrices(Fetch fetch, LongSupplier now, Consumer<String> diagnostic) {
    this.fetch = fetch; this.now = now; this.diagnostic = diagnostic;
  }
  synchronized void start(String streamId, String cookie, boolean automatic) {
    if (started || closed || streamId == null || cookie == null || !streamId.matches("[A-Za-z0-9_-]{1,128}") || cookie.length() > 24000 || cookie.matches("(?s).*[\\r\\n\\x00].*")) return;
    started = true;
    this.streamId = streamId; this.cookie = cookie;
    refresh(); // Before WebSocket connection: the first gift can carry its price.
    if (automatic && !suspended && !closed) {
      scheduler = Executors.newSingleThreadScheduledExecutor(task -> { Thread thread = new Thread(task, "kuaishou-gift-prices"); thread.setDaemon(true); return thread; });
      scheduler.scheduleWithFixedDelay(this::refresh, 4, 4, TimeUnit.MINUTES);
    }
  }
  synchronized boolean refresh() {
    if (closed || suspended || streamId.isEmpty() || failures >= 3) return false;
    try {
      String body = fetch.get("https://live.kuaishou.com/live_api/emoji/gift-list?liveStreamId=" + streamId, cookie);
      if (closed) return false;
      acceptCatalog(body);
      failures = 0; diagnostic.accept("giftPriceCatalogReady"); return true;
    } catch (Exception ignored) {
      failures++; diagnostic.accept(suspended ? "giftPriceCatalogRestricted" : "giftPriceCatalogUnavailable");
      if ((suspended || failures >= 3) && scheduler != null) scheduler.shutdown();
      return false; // A missing price must never discard a received gift or become a zero price.
    }
  }
  void acceptCatalog(String body) throws Exception {
    if (body.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw new IllegalArgumentException("Catalog too large");
    var data = JSON.readTree(body).path("data");
    if (data.has("result") && data.path("result").asInt() != 1) {
      int result = data.path("result").asInt();
      if (result == 2 || result == 15 || result == 16 || result == 109 || result == 400002 || result == 7935) suspended = true;
      throw new IllegalArgumentException("Catalog unavailable");
    }
    var gifts = data.path("gifts");
    if (!gifts.isArray() || gifts.size() == 0 || gifts.size() > 10000) throw new IllegalArgumentException("Invalid catalog");
    var next = new HashMap<String, Long>(); var conflicts = new HashSet<String>();
    for (var gift : gifts) {
      String id = gift.path("id").asText(); var unit = gift.path("unitPrice");
      if (!id.matches("[0-9]{1,20}") || !unit.isIntegralNumber() || !unit.canConvertToLong() || unit.asLong() <= 0 || unit.asLong() > 1000000000L) continue;
      Long previous = next.putIfAbsent(id, unit.asLong());
      if (previous != null && previous.longValue() != unit.asLong()) conflicts.add(id);
    }
    conflicts.forEach(next::remove);
    if (next.isEmpty()) throw new IllegalArgumentException("No prices");
    prices = Map.copyOf(next); expiresAt = now.getAsLong() + TTL_MS;
  }
  Long price(String giftId) { return closed || now.getAsLong() >= expiresAt ? null : prices.get(giftId); }
  @Override public synchronized void close() { closed = true; if (scheduler != null) scheduler.shutdownNow(); cookie = ""; prices = Map.of(); }
  private static String request(String url, String cookie) throws Exception {
    var connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
    connection.setConnectTimeout(4000); connection.setReadTimeout(4000); connection.setInstanceFollowRedirects(false);
    connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36");
    connection.setRequestProperty("Accept", "application/json");
    connection.setRequestProperty("Referer", "https://live.kuaishou.com/");
    if (!cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
    try {
      int status = connection.getResponseCode();
      if (status == 401 || status == 403 || status == 429) return "{\"data\":{\"result\":2}}";
      if (status != 200 || connection.getContentLengthLong() > MAX_BYTES) throw new IllegalArgumentException("Catalog HTTP failure");
      try (var input = connection.getInputStream()) {
        byte[] bytes = input.readNBytes(MAX_BYTES + 1);
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("Catalog too large");
        return new String(bytes, StandardCharsets.UTF_8);
      }
    } finally { connection.disconnect(); }
  }
}
