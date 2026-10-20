# 能力路线图

核查日期：2026-10-20，版本 0.2.0。这里区分已实现的解析、授权环境待验证项与缺失的数据入口；没有承诺上线时间。实际支持范围以 [README 能力表](../README.md#当前数据能力) 为准。

## 先做好独立可用的底层

首版已经包含平台采集适配、统一事件、去重与有限重连、头像缓存、订阅接口、测试和示例。后续优先保持字段语义准确、故障可定位、四平台相互隔离；协议升级不能把不确定数据变成虚假的完整数据。

| 状态 | 工作 | 当前证据与实现 | 仍需完成 |
| --- | --- | --- | --- |
| 已适配基础双人模式 | B站 PK 比分与对手 | 7 个旧版／新版准备、开始、进度和结束命令；双方房间、精确比分、来源单位及对手资料；真实 SDK 编解码与核心接入离线测试 | 授权直播间验证字段覆盖；更多团队／特殊 PK 模式；不根据当前比分猜最终胜负 |
| 已适配目录映射 | 视频号礼物图片 | 官方后台 `gift_enum_list` 的 `data.giftList`，按 `rewardProductId → thumbnailFileUrl` 映射；按房间隔离、有界缓存、过期与乱序保护，不重放礼物 | 授权后台验证实际目录时序及图片 CDN；后台未返回目录或来源不受支持时仍无图 |
| 已适配部分比分协议 | 抖音更完整的 PK | 官方网页协议和 PK 组件确认双人比分更新与结束比分；区分参赛者与贡献者，模糊／相对分数只保留显示文本 | 授权环境验证不同模式；团队、多人和特殊玩法仍需各自字段依据，不能宣称完整 PK |
| 仍缺可靠事件 | 快手逐人进房 / 关注 | 复核 OrdinaryRoad 1.5.8 及当前官方静态协议，现有 feed 不含明确逐人动作；入房 ACK 是采集连接握手，富文本不能确证动作类型 | 需要真实、明确的动作协议来源；不从首次发言、榜单变化或人数变化推断 |
| 新增部分名单；全量仍缺 | 四平台全量在线名单 | 视频号新增后台 `liveContacts` 可见名单；快手部分观看列表与抖音贡献榜补头像，抖音另保留原始名次。现有来源均无全量完成依据 | 只有来源确实提供全量范围与完成标记，才可声明完整；不能合并互动记录假造全名单 |

本轮没有真实账号或直播间实测。离线测试验证解析、字段边界和采集管线，不证明每个房间都会推送这些消息。快手完整 PK 与视频号 PK 仍缺可靠比分结构；视频号仅确认了 `pkStatus=20018` 枚举，枚举本身不足以解析状态或比分。

固定参考入口（独立字段适配，不分发上游源码）：

- [B站 PK 数据模型](https://github.com/qydysky/bili_danmu/tree/76304fa1c5e337d20837a2b346a3c2a90c680996/Reply/ws_msg)与[结束事件类型](https://github.com/ShmilyChen/bilive_client/blob/c0d70369ef5b3128309201ffb0f65522b31d5444/bilive/%40types/danmaku.d.ts)。
- [视频号官方礼物图片消费字段](https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/794.72f12fb9.js)和[官方接口／目录结构](https://res.wx.qq.com/t/wx_fed/finder/helper/live/finder-helper-live/res/static/js/async/805.b6dd9a5a.js)。旧[开源请求线索](https://github.com/wordweb/Get-Tencent-Video-Live-Barrage-Gifts/blob/002d1186f138cb8e15d2b389a9bc71cc797b49f9/webapi.py)没有图片字段解析，也未找到许可证，未复制其代码。
- [抖音官方消息协议](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/live-schema-im.e322bd8a.js)；不同模式须分别验证，不把其他平台的同名协议直接套用。
- [快手当前官方静态协议](https://p2-game.kskwai.com/udata/pkg/KS-GAME-WEB/pc-live-next/js/app.1241f9804c38413b871f.js)与[名单展示处理](https://p2-game.kskwai.com/udata/pkg/KS-GAME-WEB/pc-live-next/js/liveRoom.1241f9804c38413b871f.js)。调研只读取公开静态资源，没有进入直播间。

引入代码前核对固定提交、许可证与必要归属。上面列出的调研项目不是本仓库的运行依赖；当前实际使用的第三方来源见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 每次适配的验收方式

1. 明确消息来源、平台、房间、消息 ID、数量或状态字段的真实语义。
2. 用不含账号或真实观众记录的合成 fixture 覆盖重复、乱序、缺字段、异常和关闭。
3. 运行 Windows / Linux 离线 CI；涉及登录或平台协议变化时，另做授权环境的真实连接验证，标明范围。
4. 同步能力表、API 文档与更新记录，不把离线测试通过描述为所有直播间可用。

## 开源与产品的分工

| 范围 | 内容 |
| --- | --- |
| 公开基础组件 | 采集适配、事件格式、去重重连、头像缓存、订阅、测试与示例 |
| FurryUP 产品能力 | FurryUP Studio 工作台、完整 OBS 操作体验、直播助手、角色互动、系列产品联动 |
| 持续私有 | 凭据、真实用户记录、账户服务和内部资料 |

欢迎开发者基于底层实现自己的四平台工具。FurryUP 产品将继续在稳定维护、完整体验与系列联动上迭代。
