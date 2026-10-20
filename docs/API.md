# API 与接入说明

本文对应当前仓库源码。示例中的 `require('./core/index.cjs')` 假定调用文件位于仓库根目录；放到其他目录时请调整相对路径。当前通过源码使用，不要求发布或安装同名 npm 包。

## 三层接口

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 统一事件核心 | `core/index.cjs` | 校验、标准化、按房间去重、订阅、有界历史与头像补全 |
| Java 采集进程 | `createJavaCollector()` | 启动 B站、抖音或快手采集器，通过 stdin 配置，通过 stdout 接收事件，有限重连 |
| 视频号后台采集 | `wechat/wechat-collector.cjs` 的 `WechatCollector` | 在 Electron 主进程中打开官方后台，读取当前账号自己直播间的消息响应 |

`openRoom()` 只创建内存中的数据处理会话，不登录、不连接直播间。一个 Java 采集器对应一个房间会话；视频号实际房间 ID 由后台响应提供。四个平台可以同时运行，但平台权限、推送覆盖和字段完整度仍各不相同。

## `createLiveConnect(options?)`

```js
const { createLiveConnect } = require('./core/index.cjs');
const live = createLiveConnect({ maxRooms: 16 });
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `maxRooms` | `16` | 同时打开的房间会话上限，整数 `1–64` |
| `avatarCacheOptions` | `{}` | 可设图片下载 `timeoutMs`，默认 `8000`，范围 `1–60000`；`fetchImpl` 用于注入 Fetch 兼容实现 |
| `profileOptions` | `{}` | 快手资料查询的限速、超时、缓存参数，见资源上限；`fetchImpl`、`now` 可用于离线测试 |

默认使用 Node.js 的 `fetch`。导出的 `LiveConnect` 类与工厂等效；`PLATFORMS`、`EVENT_TYPES` 是当前支持值的只读数组。`LiveEventStream`、`normalizeEvent` 及头像辅助函数属于低层接口，普通接入建议通过房间会话完成路由与生命周期管理。

### 房间会话

```js
const room = live.openRoom({
  platform: 'kuaishou',
  roomId: 'YOUR_ROOM_ID',
  // 只有明确启用快手资料补全时才传入，由调用方从安全存储读取：
  kuaishouCookie: ''
});

// rawEvent 来自 Java 的 message.event，或视频号 onEvent 的第一个参数。
function receive(rawEvent) {
  const accepted = room.ingest(rawEvent);
  // accepted 是标准事件；重复消息返回 null；无效事件抛出异常。
  return accepted;
}
```

`platform` 为 `bilibili`、`douyin`、`kuaishou`、`wechat` 之一。核心要求 `roomId` 是非空、无控制字符、长度不超过 256 的字符串；Java 采集与快手资料接口进一步要求匹配 `[A-Za-z0-9_-]{1,128}`。使用平台实际房间 ID，不传完整网页 URL。

同一个 `live` 中不能重复打开相同的平台和房间。传入事件中的 `platform`、`room_id` 不决定路由，由所属会话覆盖，因此调用方必须把原始事件交给正确的会话。`preview: true` 不允许进入真实房间会话。

| 方法 / 属性 | 返回值与行为 |
| --- | --- |
| `room.platform`、`room.roomId` | 会话绑定的路由 |
| `room.ingest(rawEvent)` | 同步返回冻结的标准事件，重复则为 `null`；字段或数量无效时抛出异常 |
| `room.history()` | 该房间当前保留的历史数组 |
| `room.close()` | 同步、可重复调用；取消资料查询，清空该房间身份缓存、历史与去重记录。之后不能再 `ingest` |
| `live.close()` | 关闭全部房间、取消图片下载、移除订阅；可重复调用，之后不能重新打开房间 |

**核心关闭不会停止独立的 Java 进程或视频号窗口。** 先 `await runner.stop()` / `await wechat.stop()`，再关闭房间或核心。房间关闭后可以新建同一路由会话；旧会话的延迟资料结果不会进入新会话。

### 订阅与历史

```js
const unsubscribe = live.subscribe(event => {
  // 同步处理；耗时工作放入自己的有界任务队列。
}, { platform: 'kuaishou', roomId: 'YOUR_ROOM_ID', eventTypes: ['comment', 'gift'] });

const unsubscribeAvatars = live.subscribeAvatars(update => {
  // 更新已有消息的头像，不能重新触发礼物、计数或互动动作。
}, { platform: 'kuaishou', roomId: 'YOUR_ROOM_ID' });

const recent = live.history({ eventTypes: ['comment'] });
// 完成后调用 unsubscribe()、unsubscribeAvatars()。
```

两个订阅都返回取消函数；过滤器可省略或组合使用 `platform`、`roomId`、`eventTypes`，多个条件按“且”匹配。空 `eventTypes: []` 不匹配任何事件。订阅只接收后续事件，不自动重放历史。

监听器按注册顺序调用；核心隔离每个监听器的同步异常与异步 Promise 失败，不会因一个回调失败而中断其他订阅。通过 `live.on('observer-error', handler)` 可收到 `{ channel: 'event' | 'viewer-avatar', code: 'OBSERVER_CALLBACK_FAILED' }`，不包含异常原文或事件数据；该错误监听器自身失败不会递归报告。直接 `.on()`、`.once()` 和两种订阅接口均受保护。异步回调仍不被等待，业务重试、持久化与有界队列由调用方管理。

历史上限是**一个核心实例共 100 条**，不是每个房间各 100 条；返回数组中的事件为只读对象。`room_stats`、`viewer_snapshot`、`pk_status` 不进入历史。`super_chat_delete` 会移除该房间对应醒目留言，本身也不进入历史。其余事件可进入历史，不能把历史长度当作弹幕数或观众数。

去重窗口为 10 分钟，最多保存 20000 个事件标识，按平台和房间隔离。有效输入 `event_id` 优先于 `source_msg_id`；标识不能超过 512 字符，也不能含控制字符或首尾空白，数字必须是非负安全整数。两者都缺失或无效时生成新 UUID，不截断标识，也不按文本、昵称或礼物名称合并。超过时间或容量边界后，旧消息可能再次被接收。已经标准化的事件不应再次当成原始事件 `ingest`，否则其 `event_id` 会再次包装。

## 标准事件

`subscribe()` 得到的是事件对象，不含 Java 原始输出的 `{ kind: 'event', event: ... }` 外壳。未知或无效的可选字段会被省略；不要把缺失值补成真实的零。扩展字段可能增加，消费端应忽略不认识的字段。

| 字段 | 类型 / 语义 |
| --- | --- |
| `schemaVersion` | 当前为 `1` |
| `event_id` | 核心生成的路由隔离标识，适合当前处理链去重和消息索引；不是平台原始消息编号 |
| `source_msg_id` | 原始来源标识或空字符串；保存时优先用完整的 `event_id` |
| `sequence` | 当前核心实例接收事件的递增序号，不是平台全局序号 |
| `platform`、`room_id`、`event_type` | 路由与事件类型 |
| `source`、`preview` | 来源标签；正常房间会话 `preview` 为 `false` |
| `user_id`、`user_name` | 字符串；缺失 ID 为 `''`，缺失昵称为“一位朋友”。昵称不能作为身份键 |
| `user_identity_hidden` | 仅在确认隐藏身份时为 `true`；不参与跨消息头像补全 |
| `avatar_url`、`avatar_id` | 有效头像的 HTTPS URL 与散列标识；无可靠头像时省略 |
| `content`、`emotes` | 清理后的文本，最多 1000 字符；表情为 `{ token, url, id }` 数组，最多 32 项 |
| `count`、`count_mode` | `delta` 是本条增量；`snapshot` 是快照、`count=0`；`signal` 仅表示发生了动作 |
| `timestamp`、`received_at` | 毫秒时间戳。前者保留有效输入时间，否则使用本机时间；后者是核心接收时间，不保证原始动作发生时间 |
| `value` | 当前始终为 `null`，不表示人民币价值 |

### 业务字段与计数

| 事件类型 | 字段与使用方式 |
| --- | --- |
| `comment` | 使用 `content` 和可选 `emotes`；渲染时按文本处理，不能直接作为 HTML |
| `gift` | `gift_id`、`gift_name`、`gift_count`；标准化后 `count === gift_count`，范围 `1–1000000` |
| `like` | Java 平台按已知增量输出；视频号 `count_mode='signal'`，即使 `count=1` 也不能解释为精确新增一赞 |
| `enter`、`follow`、`share` | 仅输出已识别的对应协议动作；不从名单变化或普通通知文本推断 |
| `notice`、`entry_effect` | 提示和入场特效信息；不自动等价于关注、普通进房或付费礼物 |
| `super_chat` | `super_chat_id`、`content`、可选 `super_chat_price_raw/unit`、`super_chat_duration`（秒） |
| `super_chat_delete` | B站 `super_chat_ids` 数组；消费端应同时移除自己已经显示或持久化的对应消息 |
| `room_stats` | 可选 `watching_count` 当前观看、`watched_count` 累计观看、`liked_count` 累计点赞；是状态值，不相加 |
| `live_status` | 已知值包括 `started`、`ended`、视频号的 `waiting`；与采集连接状态分开处理 |
| `viewer_snapshot` | `viewer_snapshot` 对象，见下文；不等价于全量在线名单 |
| `pk_status` | `pk` 对象，见下文；当前没有完整比分和胜负能力 |

礼物可选字段为 `gift_image_url/id`、`gift_price_raw`、`gift_price_unit`、`gift_coin_type`、`gift_unit`、`combo_id`、`receive_user_id/name`。徽章可选字段为 `badge_name`、`badge_level`。B站会员类礼物可有 `gift_kind='membership'`，及已知时的 `membership_action='purchase'|'renew'`。

价格在核心中规范为十进制**字符串**，保留平台语义。B站普通礼物的 `bilibili_coin` 及 `gift_coin_type`、抖音的 `diamond` 取已知原始单位价格；视频号 `wechat_bean` 来自奖励消息的 `reward_amount_in_wecoin`，保留交易金额语义，不能统一再乘一次数量。B站醒目留言 `cny` 是该消息的原始金额。缺失价格、币种和图片都不会凭空补齐，也不换算跨平台收入。

快手、抖音礼物保留 SDK 已计算的增量，不把每条连击的显示总数再次累计。视频号只把已确认的奖励消息计作礼物，忽略连击总数通知的重复计数。

### 观众与 PK 快照

`viewer_snapshot` 包含 `source`、`presenceEvidence`、`complete`、可选 `revision` 和 `viewers`。每个观众可有 `userId`、`userName`、`userLevel`、`wealthLevel`、`online`、`highWealth`。

当前快手可见名单标记为 `presenceEvidence='online-list'`，抖音贡献榜为 `'unknown'`；两者 `complete=false`。抖音当前适配读取 `ranksList`，不是所有座位或全部观众；核心也不保留榜单分数、名次和头像。缺失、消失或过期的观众条目不能证明完整离场，更不能由此计算所有人的精确停留时间。

`pk` 包含 `battleId`（可能为 `null`）、`phase='active'|'ended'`、`protocol`、`observedAt`，及可选 `reason`、`sourceTimestamp`、`sourceTime`、`revision`、`startedAt`、`endsAt`。毫秒时间与原始数字字符串分别保留，不猜未知单位。抖音只有协议同时提供可信开始时间与时长时才有 `endsAt`；快手没有倒计时。`reason='link-ended'` 表示快手连线结束证据，不表示已确定某一场 PK 的胜负；`battle-refresh` 不保证带有场次 ID。

## 头像缓存与异步补全

普通缓存只在同一房间、同一可靠用户 ID 内复用，默认保留 30 分钟。消息自身带头像时优先保留。隐藏身份不消费或填充身份缓存；如果原消息自己带有合法头像，可保留该消息的头像。

只有快手房间显式提供 `kuaishouCookie` 时，才可能查询缺头像的普通弹幕。查询要求可靠 ID、当前房间、非隐藏身份；返回资料还必须与请求 ID 一致。查询不阻塞弹幕接收，失败不会伪造头像或使主采集器重连。

查询成功后，`subscribeAvatars()` 收到保留原始 `event_id` 和 `sequence` 的事件形状，附带 `avatar_url/id`。它是**元数据更新**：不会再调用普通互动订阅，不增加礼物或互动计数。核心会更新当前历史中同房间、同用户、非隐藏且缺头像的行；若用于定位的原始弹幕已离开历史或会话已关闭，则丢弃延迟更新。消费端也应检查消息是否仍显示、是否已经删除，而不是重新添加消息。

```js
async function readImage(live, event) {
  if (!event.avatar_id) return null;
  const image = await live.getAvatar(event.avatar_id);
  if (!image) return null;
  // image.type: image/png、image/jpeg、image/webp、image/gif 或 image/avif
  // image.body: Node.js Buffer；不是路径、URL 或 data URI。
  return image;
}
```

`getAvatar()` 只读取核心已从事件或头像更新登记的 ID。无登记、下载失败、超时、队列已满或关闭后返回 `null`；不会向图片服务器发送平台 Cookie。下载仅限各平台允许的 CDN 和图片类型。消息进入核心时只登记 URL，不立即下载。

`gift_image_id` 和 `emotes[].id` 当前**没有自动登记**到 `live.getAvatar()`；不能将其当作通用图片代理。UI 可以使用对应的经过校验的 URL，并按自身环境设置图片加载和内容安全策略。

## `createJavaCollector(options)`

```js
const { createLiveConnect, createJavaCollector } = require('./core/index.cjs');
const { root, java, classpath } = require('./scripts/java-runtime.cjs');
const live = createLiveConnect();
const room = live.openRoom({ platform: 'bilibili', roomId: 'YOUR_ROOM_ID' });
const runner = createJavaCollector({
  room, java, classpath, cwd: root, cookie: '',
  onState: state => { /* 处理连接状态；不要把它当成直播互动。 */ }
});
runner.start();

async function shutdown() {
  await runner.stop();
  live.close();
}
```

| 参数 | 默认 / 限制 |
| --- | --- |
| `room` | 必填，已打开的 B站、抖音或快手房间会话 |
| `java` | 默认 `'java'`，依赖 PATH；**工厂不会自动读取 `JAVA_HOME`**。仓库的 `scripts/java-runtime.cjs` 会读取它 |
| `classpath` | 必填，含采集器 JAR 与运行依赖；自行拼接时使用 Node.js `path.delimiter` |
| `cwd` | 可选，子进程工作目录；相对 classpath 以它为基准 |
| `cookie` | 默认空字符串，不含换行；配置整体最多 32768 字节，通过 stdin 发送，不放入命令行 |
| `retryDelays` | 默认 `[3000, 6000]` 毫秒；最多 5 项，每项整数 `0–60000`；`[]` 禁用重试 |
| `connectTimeoutMs` | 默认 `45000`，整数 `1–120000` |
| `stopTimeoutMs` | 默认 `2000`，整数 `1–120000`；超过后尝试强制终止进程 |
| `onState` | 接收 `{ state, code?, retries, retryLimit }`；默认空函数 |
| `spawnProcess` | 可注入进程工厂，主要用于离线测试 |

`start()` 同步发起启动，不返回“已连接”的 Promise；等待 `onState` 的 `connected` 判断连接。实例只允许启动一次。`stop()` 返回 Promise，可重复调用：取消重连、清除保留配置、关闭 stdin，必要时终止进程，并等待实际 `close`。若操作系统无法终止子进程，不会冒险并行启动替代进程，也不保证 `stopTimeoutMs` 就是整个停止 Promise 的完成时间。

`onState.state` 包括 `connecting`、`connected`、`failed`、`reconnecting`、`stopped`、`event-rejected`。重试预算在整个实例生命周期内消耗，连接成功不会重置；默认最多初次连接加两次重试。处理完需要人工介入的情况后，创建新的采集器实例。

| 错误码 | 当前重试策略 |
| --- | --- |
| `NETWORK_TIMEOUT`、`NETWORK_UNREACHABLE`、`CONNECT_FAILED`、`PROCESS_EXIT` | 等待旧进程结束后按剩余预算重试 |
| `LOGIN_REQUIRED`、`VERIFICATION_REQUIRED`、`RATE_LIMITED` | 停止，由用户在官方页面检查登录、验证或限流 |
| `NO_LIVE_SESSION`、`ROOM_OFFLINE` | 停止，确认房间和开播状态后再连接 |
| `PROTOCOL_CHANGED`、`INVALID_OUTPUT` | 停止，检查版本、输出协议和适配 |
| `TLS_ERROR`、`LOCAL_NETWORK_INIT`、`PROCESS_START` | 停止，检查本机证书、网络选择器、运行环境或进程路径 |

上游错误分类是有限规则，不能覆盖所有平台错误。无效互动会报告 `event-rejected` 并继续处理；损坏 JSON 或超限 stdout 属于 `INVALID_OUTPUT`。当前包装器只转发 `kind='event'` 到房间会话，处理部分 `status`，忽略 `room-info`、`diagnostic`，并丢弃 stderr 文本。需要原始房间标题或诊断时使用原始进程接口，另行处理这些记录。

## 视频号适配

在 Electron `app.whenReady()` 之后创建实例，`BrowserWindow` 和 `session` 必须来自主进程。它不接受任意他人房间号；登录官方后台后，房间 ID 由成功的消息响应确定。

```js
const { WechatCollector } = require('./wechat/wechat-collector.cjs');
const { createLiveConnect } = require('./core/index.cjs');

async function attachWechat({ BrowserWindow, session }) {
  const live = createLiveConnect();
  const rooms = new Map();
  const collector = new WechatCollector({
    BrowserWindow, session,
    credentials: { has: () => false, read: () => '', save: () => {}, clear: () => {} }
  });
  await collector.connect({
    remember: false,
    onState: state => { /* awaiting-login、connected、message-error 等 */ },
    onDiagnostic: metric => { /* giftCallbacks / giftParseErrors / observerErrors */ },
    onEvent(raw, roomId) {
      try {
        if (!rooms.has(roomId)) rooms.set(roomId, live.openRoom({ platform: 'wechat', roomId }));
        rooms.get(roomId).ingest(raw);
      } catch { /* 记录失败次数，不输出原始响应。 */ }
    }
  });
  return { live, async stop() {
    try { await collector.stop(); }
    finally { live.close(); }
  } };
}
```

`connect()` 的 Promise 完成表示后台初始化流程完成，不表示已扫码登录或已有有效直播消息。通过回调状态观察进展；`message-error` 可能是暂时加载失败，窗口仍会保留供刷新。`onState` 也可能只包含 `error` 或 `loginSaved`，消费端应合并已提供的字段，不假定每次都有 `state`。

`onState`、`onEvent`、`onDiagnostic` 的同步异常和异步失败会被隔离，通过 `collector.on('observer-error', handler)` 报告固定的 `{ channel, code: 'OBSERVER_CALLBACK_FAILED' }`；`channel` 对应这三个回调名称。前两者失败时还会通知 `onDiagnostic('observerErrors')`，诊断回调自身失败不再次调用它。异步回调不被等待。

较旧请求的迟到响应不会覆盖较新连接状态、直播状态或房间统计；其中真实互动仍按原始 `roomId` 交给 `onEvent`。因此按事件自己的房间 ID 路由，不以“最后到达的互动”判断当前房间。示例用 Map 保留已接入房间；长期运行时由业务在不再需要时关闭并移除旧会话，仍受 `maxRooms` 限制。

构造参数另有 `showWindows=true`、`onLoginDiagnostic`。后者仅提供受限状态信息，例如登录阶段、HTTP 状态和已知数字错误码，不提供 Cookie 或原始登录响应。

`connect({ remember })` 默认 `remember=true`；示例明确设为 `false`。开启记忆时，调用方必须提供同步 `credentials.has(key)`、`read(key)`、`save(key, value)`、`clear(key)`，键为 `'wechat'`，值为序列化 Cookie JSON。加密持久化由调用方实现，本库不提供凭据存储。

- `await collector.stop()`：停止采集、销毁窗口并清理浏览器临时存储；若开启记忆，可保存 Cookie，但不会自动删除调用方已保存的记录。
- `await collector.stop({ preserveSession: true })`：仅在本次 `remember=true` 时保留完整临时 Chromium 会话，供同一实例重新连接使用；不保证跨进程保留完整账号选择状态。
- `await collector.setRemember(false)`：禁用记忆并清除调用方保存的 Cookie；仍在运行的窗口继续使用其当前会话。需要彻底结束时再 `stop()`。
- `collector.focus()`：显示并聚焦现有后台窗口。

纯解析可直接调用 `decodeWechatResponse(body, request?)`，从 `wechat/wechat-decoder.cjs` 导入。`body` 是 JSON 字符串；响应没有提供房间 ID 时，`request.liveId` 可作为后备；无效或冲突的房间标识会被拒绝。成功返回 `{ roomId, events, liveStatus, errors, giftCallbacks, giftParseErrors }`；未确认房间时返回空事件，登录或协议错误可能返回 `error='LOGIN_OR_PROTOCOL'`。非法 JSON、超大响应等会抛出异常。视频号原始身份和消息编号超过 128 字符时不会截断拼接成另一个身份；无可靠消息编号时留给核心生成独立标识。纯解析不创建连接、不去重，`liveStatus` 也需要调用方按状态变化处理；建议使用现成采集器接入核心。

## 四平台并行

用一个核心统一订阅，为三个 Java 平台各建一个采集器，视频号通过自己的回调接入第四个会话。以下函数在 Electron 主进程、`app.whenReady()` 后调用；`javaRooms` 提供三个房间配置，Cookie 由调用方安全读取，不在代码中写死。

```js
const { createLiveConnect, createJavaCollector } = require('./core/index.cjs');
const { WechatCollector } = require('./wechat/wechat-collector.cjs');

async function startFourPlatforms({
  BrowserWindow, session, javaRooms, java, classpath, cwd,
  onEvent = () => {}, onAvatar = () => {}, onState = () => {}
}) {
  const live = createLiveConnect();
  const runners = [];
  const wechatRooms = new Map();
  live.subscribe(onEvent);
  live.subscribeAvatars(onAvatar);
  const wechat = new WechatCollector({
    BrowserWindow, session,
    credentials: { has: () => false, read: () => '', save: () => {}, clear: () => {} }
  });
  async function stop() {
    const results = await Promise.allSettled([
      ...runners.map(runner => Promise.resolve().then(() => runner.stop())),
      Promise.resolve().then(() => wechat.stop())
    ]);
    live.close();
    if (results.some(result => result.status === 'rejected')) {
      throw new Error('One or more collectors failed to stop');
    }
  }
  try {
    for (const { platform, roomId, cookie = '' } of javaRooms) {
      const room = live.openRoom({
        platform, roomId, kuaishouCookie: platform === 'kuaishou' ? cookie : ''
      });
      const runner = createJavaCollector({
        room, java, classpath, cwd, cookie,
        onState: state => onState({ platform, roomId, ...state })
      });
      runners.push(runner);
      runner.start();
    }
    await wechat.connect({
      remember: false,
      onState: state => onState({ platform: 'wechat', ...state }),
      onEvent(raw, roomId) {
        try {
          if (!wechatRooms.has(roomId)) {
            wechatRooms.set(roomId, live.openRoom({ platform: 'wechat', roomId }));
          }
          wechatRooms.get(roomId).ingest(raw);
        }
        catch { onState({ platform: 'wechat', roomId, state: 'event-rejected' }); }
      }
    });
    return { live, stop };
  } catch (error) {
    try { await stop(); } catch { /* 清理失败需单独计数，不覆盖原始启动失败。 */ }
    throw error;
  }
}
```

`javaRooms` 的三项分别使用 `bilibili`、`douyin`、`kuaishou`。订阅过滤可将各平台交给不同业务组件；关闭应用时 `await stop()`。四个平台意味着三个 JVM 进程和一个 Electron 后台窗口，并非单条连接。房间上限是内存保护，不是建议同时请求这么多直播间。

## 默认资源边界

| 资源 | 当前默认值 / 硬上限 |
| --- | --- |
| 核心房间 | 默认 16，可配至 64 |
| 事件历史 / 去重 | 全实例 100 条历史；去重 10 分钟 / 20000 项 |
| 身份头像缓存 | 每房间最多 2048 个用户；默认 30 分钟 |
| 图片缓存 | 每核心最多 256 项 / 16 MiB；每张最多 2 MiB |
| 图片请求 | 4 并发、32 个等待任务；默认超时 8 秒；成功缓存 30 分钟，失败缓存 1 分钟 |
| 快手资料请求 | 每房间 1 并发、最多 64 个等待任务；默认间隔 1 秒、超时 5 秒 |
| 快手资料缓存 / 风控 | 默认成功 30 分钟、失败 5 分钟、风控冷却 5 分钟；响应最多 128 KiB |
| Java 配置 / 输出 | 配置最多 32768 字节；stdout 单行和未换行缓冲各最多 256 KiB |
| 视频号响应 | 消息体最多 2 MiB；最多 4 个并发读取；每个消息数组最多处理前 2000 项 |
| 观众 / 撤回列表 | 单次观众快照最多 500 项；SC 撤回 ID 最多 128 项 |

`profileOptions` 可配置 `spacingMs=1000`（`0–60000`）、`timeoutMs=5000`（`1–60000`）、`positiveTtlMs=1800000`、`negativeTtlMs=300000`、`cooldownMs=300000`（后三项均 `1–86400000`）、`maxEntries=2048`（`1–2048`）、`maxQueued=64`（`1–64`）。快手房间的 `roomId`、Cookie 与完成回调由房间会话设置。生产接入应保留合理间隔；多个房间的限速不是全局账号限速。

这些是局部缓存、队列和消息边界，不是整个 JVM / Electron 的总内存限制，也不是平台吞吐保证。收到快照后多久显示为过期、是否持久化、跨进程去重和业务任务排队由调用方实现。进一步排查见 [故障排查](TROUBLESHOOTING.md)。
