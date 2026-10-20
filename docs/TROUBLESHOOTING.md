# 故障排查

先区分三个阶段：构建是否成功、采集器是否连接、平台是否下发了目标事件。离线测试通过证明固定样例和生命周期行为，不等于某个真实账号或直播间当前一定可用。接口详情见 [API 文档](API.md)。

## 运行环境与构建

在仓库根目录检查：

```sh
node --version
java -version
javac -version
mvn -version
npm run build
npm test
```

需要 Node.js 22.12+，Java 采集需要 JDK 21+ 和 Maven 3.9+。`JAVA_HOME` 应指向 JDK 根目录，不是 `bin` 或 `java` 可执行文件；Maven 应可从 PATH 找到。`mvn -version` 会显示它实际使用的 Java 版本，须与预期一致。

| 现象 | 检查与处理 |
| --- | --- |
| 找不到 `mvn` / Maven 无法启动 | 安装 Maven，确认新终端中的 PATH；Windows 使用 `mvn.cmd` |
| `release version 21 not supported` / 编译器过旧 | 检查 `mvn -version`、`JAVA_HOME`，使用 JDK 21 或更新版本 |
| 只有 `java`，没有 `javac` | 当前可能是 JRE，需要完整 JDK 进行构建 |
| `UnsupportedClassVersionError` | 运行时 Java 低于编译目标；检查实际启动的 Java 路径 |
| 找不到 `local.furryup.Collector` | 先执行 `npm run build`；确认 `collector/target/collector.jar` 和 classpath |
| 缺少 OrdinaryRoad 或其他类 | 同时包含 `collector/target/lib/*`；只复制采集器 JAR 不够 |
| Maven 下载失败 | 检查网络、代理及 Maven settings；保留依赖版本和校验，不以不明来源 JAR 替换 |
| 修改 fixture 后 Maven 显示成功但没有测试输出 | fixture 是带 `main` 的离线程序，需运行 `npm run test:java` 或 `npm test` 才会执行 |

`scripts/java-runtime.cjs` 会根据 `JAVA_HOME` 选择 Java；直接调用 `createJavaCollector()` 默认只使用 PATH 中的 `java`。嵌入时可以显式传入 `java` 路径。自行拼接 classpath 时使用 Node.js `path.delimiter` 或 Java `File.pathSeparator`，不要写死 Windows 的 `;`。

只验证 Node 核心及视频号解析 / 生命周期可运行：

```sh
npm run test:core
npm run test:wechat
```

这两组测试不要求安装 Electron 或连接真实平台。`npm run demo` 可查看离线事件示例，`npm run test:examples` 验证示例生命周期。运行视频号窗口前，需要 `npm ci` 安装锁定的 Electron，随后使用 `npm run start:wechat`；组合接入使用 `npm run start:multi`。在没有桌面环境的机器上通过离线测试，不代表能够扫码登录。

## 启动后立即退出，或一直没有连接

`examples/java-stdin.cjs` 和 `examples/java-subscribe.cjs` 的第一行 stdin 必须是配置 JSON：

```json
{"platform":"bilibili","roomId":"YOUR_ROOM_ID","cookie":""}
```

替换为真实房间 ID；`platform` 只接受三个 Java 平台，视频号使用自己的 Electron 接入。不要传完整 URL、空格包围的 ID 或不可见字符。

第一行之后必须保持 stdin 打开。`echo ... | node examples/java-stdin.cjs` 一类命令通常会立即产生 EOF，采集器会按设计断开。持续接入建议使用 `createJavaCollector()` 管理子进程；它会写入配置并保持管道，直到 `stop()`。

不要把 Cookie 放进命令行参数、截图、仓库或公开日志。由调用方从安全存储读取，经 stdin 传入。`openRoom()` 本身不启动采集；`runner.start()` 也不表示连接成功，应观察 `onState({ state: 'connected' })`。

默认连接等待上限为 45 秒，默认网络重试等待 3 秒、6 秒，最多两次。预算在一个实例内不会因连接成功而重置。没有预算后保持停止，需要明确重建实例，不要在 `stopped` 回调里无限自动创建新连接。

## 登录、验证、限流与下播

| 错误码 / 状态 | 处理方向 |
| --- | --- |
| `LOGIN_REQUIRED` | 在官方页面确认账号登录有效、直播间可访问；按平台需要更新本机安全存储中的 Cookie |
| `VERIFICATION_REQUIRED` | 在官方页面完成验证后再连接；不通过重复请求绕过验证 |
| `RATE_LIMITED` | 停止短间隔重试，减少并发和重复连接，等待平台允许后再试 |
| `ROOM_OFFLINE` / `NO_LIVE_SESSION` | 核对房间 ID 和开播状态；没有直播会话不是网络重试可以修复的问题 |
| `NETWORK_TIMEOUT` / `NETWORK_UNREACHABLE` | 检查 DNS、代理、连接环境；包装器只执行有限重试 |
| `TLS_ERROR` | 检查系统时间、JDK 信任证书和代理证书配置；不要关闭 TLS 校验 |
| `LOCAL_NETWORK_INIT` | 本机网络选择器或回环连接初始化失败；检查本机网络 / 安全软件 / Java 环境 |
| `PROTOCOL_CHANGED` | 可能是平台字段或协议变化；核对最新适配并提供脱敏复现 |
| `PROCESS_START` | Java 路径、可执行权限或本机进程创建失败 |
| `INVALID_OUTPUT` | stdout 出现非 JSON、过大单行或长期未换行；检查输出污染和协议边界 |
| `event-rejected` | 一条事件未通过统一核心校验；其余事件继续处理，检查事件类型、数量和必需字段 |

错误分类是有限规则，未识别的情况可能归为 `CONNECT_FAILED`，不能从这个通用错误断定“账号被封”或“需要验证码”。

Java 原始进程关闭了 SDK 自动重连。有限重连由 `createJavaCollector()` 实现；直接运行原始进程示例不会获得同样的重连管理。`--self-test` 只测组件和断言，`--network-self-test` 只测本机网络选择器，都不测试平台登录。

## 视频号后台打不开、扫码后没有消息

使用 Electron 主进程，在 `app.whenReady()` 后构造 `WechatCollector`。进入官方后台自己的直播间，不是任意他人直播 URL。`connect()` 返回后仍可能处于 `awaiting-login`；首次有效消息响应才会报告 `connected` 和后台房间 ID。

1. 先在窗口中确认页面加载、账号选择、登录与开播状态。
2. 页面暂时加载失败时会报告 `message-error` / `WECHAT_PAGE_LOAD`，保留窗口供刷新；不必每次都清空登录。
3. 消息监听断开、渲染进程退出或窗口关闭时，按状态停止并重新建立采集。
4. 不要给远程后台页面增加 Node 集成或不必要的 preload；当前实现依赖受限的浏览器响应监听。

默认公开示例 `remember=false`，停止后清理临时浏览器存储。类的 `connect()` 默认却是 `remember=true`，嵌入时请显式选择。开启记忆需要调用方实现同步凭据存储；保存 Cookie 不等于能恢复全部账号选择状态。

同一采集器实例在 `remember=true` 时，`stop({ preserveSession: true })` 可以保留完整临时会话后重连；`remember=false` 时不会保留。`stop()` 会清理浏览器临时存储，但不会自动删除调用方此前保存的 Cookie；需要删除保存记录时调用 `setRemember(false)`。不要将登录后的整个浏览器目录上传到仓库。

视频号解析器与采集器本身不会为所有互动自动去重。公开 Electron 示例带消息 ID 去重；接入统一核心时，将原始事件送到对应 `room.ingest()` 即可。后台切换房间后，旧请求的迟到互动仍可能带原房间 ID 到达；按每条回调的 `roomId` 路由，不能把所有事件送到“最近打开的房间”。旧响应不会回退新的连接状态和统计；业务结束使用某个房间后，再关闭并移除其会话。

## 弹幕仍缺头像，或更新头像时重复触发互动

先检查事件是否包含合法 `avatar_url` / `avatar_id`。平台不一定在每条消息里带头像；同房间其他消息曾提供头像时，核心可按可靠用户 ID 复用。昵称相同不能证明是同一个用户。

快手按 ID 查询需要在 `openRoom()` 中显式传 `kuaishouCookie`；只给 Java 采集器传 `cookie` 不会自动启用核心查询。缺头像普通弹幕还必须具有可靠 ID，不能是隐藏身份、`OUTSIDE` 等占位身份。查询限流、失败缓存、风控冷却和队列上限都会影响补全时机，不能承诺所有头像必定成功。

通过 `subscribeAvatars()` 接收异步结果，只修改已有行的头像，不再把它送入 `room.ingest()`，也不重新调用礼物动作或增加计数。原始消息已经被移除、隐藏或过期时应忽略更新；核心自己的历史只有全实例 100 条，超出历史的定位消息不再接收延迟回填。

`await live.getAvatar(id)` 返回 `{ type, body: Buffer }` 或 `null`，不是可直接赋给 `<img src>` 的字符串。HTTP 接口可按 `type` 设置 Content-Type 并发送 `body`；浏览器使用时由应用构造合适的 Blob / 对象 URL，并在销毁时释放。不要把平台 Cookie 加到图片请求。

下载失败可检查：ID 是否已登记、URL 是否为该平台允许的 CDN、内容类型是否为允许的图片、是否超过 2 MiB、请求是否超时或已关闭。`gift_image_id`、表情 ID 不会自动登记到 `live.getAvatar()`。原始数据缺失时不要生成随机头像冒充本人。

名单中的 `viewer_snapshot.viewers[].avatarId` 和 B站 PK 参与者的 `avatarId` 可以传给 `getAvatar()`，与弹幕头像共用图片缓存，可能被容量淘汰。名单头像不会按昵称自动关联到弹幕；视频号没有可靠 ID 的展示条目尤其不能据此判断身份。

## 视频号礼物图片或名单没有出现

这两项依赖官方后台正常请求的辅助响应。采集器只被动接收，不会自动轮询目录或翻页。先在后台正常进入自己的直播间、查看相应区域；后台若未返回该数据，库保持缺省。

礼物图片需要同房间的 `gift_enum_list` 返回已知 `rewardProductId → thumbnailFileUrl`，且图片属于当前允许的 `qpic.cn` / `qlogo.cn` CDN。目录缓存默认 30 分钟，最多 8 个房间、每房间 512 项，停止时清空。目录只补后续礼物，不回补重放之前的奖励；未知 CDN 或未匹配到的礼物 ID 不用相似名称替代。`gift_image_url` 有值时可按应用的图片策略显示，`gift_image_id` 仍不是 `getAvatar()` 的自动登记项。

在线名单来自 `online_member` 的 `liveContacts`。它必须匹配弹幕已确认的当前房间，较旧请求、其他房间、无效或超限响应会被忽略。当前没有已验证的全量分页协议；空名单、只有昵称的条目和有限人数列表都不能证明完整在线情况。`giftCatalogErrors` / `viewerSnapshotErrors` 诊断不等价于主弹幕连接失败。

## 礼物数量、金额或点赞对不上

- 使用标准事件的 `gift_count` / `count`，快手和抖音已保留 SDK 的增量；不要再次把连击总数作为增量相加。
- 视频号只计确认的奖励消息，连击汇总通知不再计一次。没有可靠消息 ID 的两条互动不会仅凭相同文本合并。
- 按核心 `event_id` 去重，不按昵称、礼物名称或时间近似去重。核心的 10 分钟 / 20000 项去重不是永久账本。
- 读取 `count_mode`。`snapshot` 表示状态快照；视频号点赞的 `signal` 不能等同精确次数。
- `gift_price_raw` 是十进制字符串，含义取决于平台。视频号字段保留该奖励消息的微信豆交易金额，不统一再乘礼物数量；B站普通礼物还应区分金币 / 银币。
- 缺价格不等于免费，未知不等于零；`value` 当前固定为 `null`，不应当作收入。

本组件采集的是平台下发的互动，不是结算账单。退款、平台分成、汇率、折扣和补发消息都不应由显示字段自行推导。

## 在线统计、观众名单和 PK 看起来不完整

`watching_count` 当前观看、`watched_count` 累计观看、`liked_count` 累计点赞不是同一种指标。只更新本条实际提供的字段；`0` 是明确值，字段缺失才是未知。“1.2万”等展示字符串不会被转换为精确人数。贡献榜、热度、榜单人数不能代替全量在线人数。

快手现在同时读取消息推送及 `340` 可见名单协议中明确的 `displayWatchingCount`；即使名单只有几人，也不能覆盖平台给出的观看数。没有该字段时不从名单长度生成统计。Java 名单有 500 项和 192 KiB UTF-8 JSON 边界，长头像地址可能使可输出条目减少；`complete=false` 始终保留。

核心不提供统计过期定时器。消费端应按**每个字段**最后一次实际收到的时间判断是否过期，断线后显示未知或已过期；新点赞不能刷新旧在线人数的有效期。快照仍会通过订阅发送，但不进入互动历史。

| 能力 | 当前边界 |
| --- | --- |
| 完整在线观众名单 | 四平台都不保证。快手是部分可见名单，视频号是后台返回的局部名单；抖音当前读取部分贡献榜，不能证明所有上榜用户此刻在线 |
| 进场 / 离场 / 停留时间 | 只能使用明确动作或已提供的在线证据；名单缺失不自动等于离场。快手尚缺可靠进房 / 关注事件 |
| PK | B站支持基础对手、比分与阶段；抖音支持明确场次的双人进度及结束比分，不覆盖多方、团队和所有玩法。快手仍为部分状态，连线结束不等于完整结算 |
| 视频号礼物图片 | 后台目录已返回且 ID、图片来源匹配时补齐后续礼物；未返回时缺省，普通通知文案不推定为分享或送礼 |
| 断线恢复 | 不保证补回断线期间所有消息，也不提供全量历史补拉 |
| 房间标题 / 诊断 | Java 原始输出可包含 `room-info` / `diagnostic`；当前 `createJavaCollector()` 不将它们透传为互动 |

不要因平台数据缺失而自动编造事件。平台字段可能受账号权限、直播类型、隐私设置与接口变化影响，测试中某条样例存在不等于所有直播间稳定提供。

B站 PK 的 `init` / `match` 是协议方位，按参与者 `roomId` 确认本方；不能固定把 `init` 当本方。准备阶段可能提供对手昵称与头像，后续比分事件未必再次携带资料，应用需按平台、房间和 `battleId` 合并。`score` 是十进制字符串，缺失不是零；不要累加进度快照、转成会丢精度的 Number，或把比分单位当成人民币。当前不输出统一 `winner` / `result`，不从贡献者昵称推断主播。

抖音进度比分仅接收 `WebcastLinkMicMethod` 的 `message_type=202`，且要求明确场次 ID。参与者使用 `side='participant'` 和 `userId`，不保证有 `roomId`。相对 / 模糊比分只给 `scoreDisplay`，不会同时暴露精确 `score`；不要从“领先”等文本反推数值。团队字段、多于两人或身份冲突时会省略双人比分，结束状态仍可能正常到达。贡献者榜单不是主播总分，断线后也不能把旧场次比分沿用到新场次。

## 关闭后进程还在，或重连出现重复采集

统一核心与采集器的生命周期分开管理：

```js
async function shutdown({ runners, wechat, live }) {
  const results = await Promise.allSettled([
    ...runners.map(runner => Promise.resolve().then(() => runner.stop())),
    Promise.resolve().then(() => wechat?.stop())
  ]);
  live.close();
  if (results.some(result => result.status === 'rejected')) {
    throw new Error('One or more collectors failed to stop');
  }
}
```

不要仅调用 `room.close()` / `live.close()` 就认为 Java 进程或后台窗口已经结束。`runner.stop()` 先关闭 stdin，默认 2 秒后尝试强制结束，再等待实际进程关闭；若系统拒绝终止，停止 Promise 可能继续等待，包装器不会同时再开替代进程。

核心会隔离订阅回调的同步异常和异步 Promise 失败，其他监听器仍能收到事件。可监听 `live.on('observer-error', handler)` 的 `OBSERVER_CALLBACK_FAILED`，并在自己的业务内部定位问题；库不会在该通知中附带异常原文或敏感事件。视频号也提供 `collector.on('observer-error', handler)`，状态或互动回调失败时另有 `onDiagnostic('observerErrors')` 计数。

异常隔离不代表业务操作自动成功或自动重试。异步工作应使用自己的有界队列；核心不会等待异步订阅，也不替业务持久化提供背压。关闭界面时取消订阅，关闭整个业务时停止采集器并关闭核心。

## 报告问题时提供什么

建议提供仓库提交或版本、系统 / Node / Java / Maven 版本、平台、稳定错误码、是否能够在官方页面正常访问，以及最小复现步骤。可先运行对应的离线测试，说明失败的用例名称。

不要提交 Cookie、登录响应、二维码、完整签名 URL、真实聊天记录、完整浏览器存储或本机用户目录。协议问题优先提供用合成昵称、ID、内容制作的最小字段结构；无法确定是否已经脱敏时，只提供字段是否存在、类型、数量及错误码。
