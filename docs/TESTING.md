# 离线测试与合成回放

抖音钱包新增合成用例覆盖月分页/游标、重叠去重、合计核对、视频/直播与未知分类、退款/提现排除、整月更正、逐月存储、重启恢复、退避、账号失效暂停、取消和磁盘失败。Electron 还验证固定钱包 GET、会话切换后恢复也拒绝、持久化及暂停联动。详见[钱包接入与实账验收边界](DOUYIN_WALLET.md)；测试没有接入真实手机钱包。

[English](TESTING.en.md) · [事件规范](EVENTS.md)

## 创作者收益（未发布）

公共同步器回归覆盖四平台定时刷新、来源独立暂停、历史批次、检查点恢复、旧账本迁移、月份边界、退避、换号、并发、取消及磁盘失败。安卓回归执行合成原生桥接和虚拟设备传输，验证固定端点、身份核对、导航拒绝、登录界限、超时、设备互斥、本机转发与清理；不调用真实手机或读取真实金额。详见[公共同步器](REVENUE_SYNC.md)和[安卓验收边界](ANDROID_REVENUE.md)。

运行 `npm run test:revenue` 验证精确金额、时区、月报范围/月份回退、分类失败、幂等更正、跨账号隔离与规范化 CSV。`npm run test:revenue:electron` 使用真正 Electron 窗口和分区内全部拦截的 HTTPS 合成响应，验证登录复用、固定收益 GET/只读 POST、登录/验证失败、身份切换、响应/时间上限、并发、取消和资源释放；CI 的 Windows creator 作业执行它。`npm run demo:revenue` 是无需网络的合成示例。

主播工作台用例覆盖三种日期范围、统计日期与固定路由请求头、音浪/人民币隔离、精确小数、跨月补齐、空点/日期冲突及当天未结束。该来源使用相同抖音分区，登录失效或身份变化不得借用另一个页面的身份继续读取。

新增快手/视频号用例覆盖激励账单分页、账期/本人 ID、元/万分元精度、空日、视频激励补录与历史恢复；第二组 Electron 检查原生客户端、钱包新登录、手机验证门槛、过期/切换会话、双窗口超时和清理。

新增代码没有登录真实收益账号；工作台 `earnScore` 也不直接代表直播钱包结算净收入。真实验收与历史缺口要求见[收益接口](CREATOR_REVENUE.md)。

回放无需 Java、Electron、账号或网络；只运行公开核心与自写合成数据，不启动任何采集器。CLI 不接收文件路径，不能拿日常用户数据直接回放。

```sh
npm run replay
npm run replay -- delivery
npm run replay -- room-switch
npm run replay -- reconnect
```

每行输出一个 JSON 报告：fixtureVersion=1、synthetic=true、场景名、接受/去重/拒绝数量、各房间累计值、选中房间和逐步 trace。标准事件的 received_at 不进入 trace，避免本机墙钟影响复现；显式合成 timestamp、ID、序号及操作顺序保留。报告是测试证据，不应送入真实礼物/支付/互动服务。

| 场景 | 预期 |
| --- | --- |
| delivery | 四平台同时存在；20 条接受、8 条重复，各房间 2 条弹幕、礼物增量 2+3=5，显式观看数 0；晚到消息保持接收顺序。 |
| room-switch | 3 条接受、1 条关闭后拒绝；旧房间礼物 5+9=14，新房间仍为 2，选中房间不被迟到消息切回。 |
| reconnect | 同会话重投去重；关闭并重建后同 ID 可再接受；旧句柄拒收。2 条接受、1 条重复、1 条拒绝。 |

可在自己的离线测试中使用：

```js
const { createSyntheticScenario, replayScenario } = require('./testing/index.cjs');
const report = replayScenario(createSyntheticScenario('room-switch'));
if (report.activeRooms[0].gifts !== 2) throw new Error('Room isolation regressed');
```

每次生成独立 fixture。回放最多 10000 步、同时房间遵循核心默认 16 个上限；场景、操作和事件键均受白名单约束，ID 必须以 synthetic- 开头。文本要求显式合成标签，拒绝 URL、文件路径、邮箱及额外凭据字段。该防误用限制不是通用脱敏认证，不可用于宣称任意输入都没有个人信息。

## 验证命令与范围

Node.js 22.12+；完整 Java 验证还需 JDK 21+、Maven 3.9+。先安装锁定测试依赖；ignore-scripts 避免仅为离线测试下载 Electron，真实 Electron 示例需要另外按既有说明安装运行时。

```sh
npm ci --ignore-scripts
npm run test:events
npm run build
npm test
npm run replay
npm run demo
npm run demo:profiles
```

事件测试使用 Ajv 严格编译公开 Schema，覆盖 14 类事件、无效结构、计数模式、未知值、TTL/容量边界、路由、回放与审计反例。Ajv 仅为开发依赖，事件核心和回放运行不依赖它。完整 npm test 还执行原核心、视频号、主页/粉丝数及 Java fixtures；CI 保留 Windows/Linux、Node 22/24 和隔离浏览器服务测试。浏览器 fixture 与合成事件不代表真实平台、账号或长时间联播验收。

## 发布前检查

```sh
npm run audit
git add <本次审核过的文件>
node scripts/audit-source.cjs --tracked
```

逐文件白名单拒绝未列入的资料、二进制、符号链接及检测到的本机用户路径/令牌/私有产品运行时引用。tracked 模式还检查暂存 blob 的真实字节及文件模式，并要求与已审计工作副本一致，不能只清洗工作副本却上传旧暂存内容。新增文件须明确加入白名单，禁止扩大成任意目录通配。

审计通过仍需人工检查 diff 与数据来源。提交前保留源码清单；对实际 Git 源码归档再次执行审计，确认只含公开组件。日志、测试输出、真实账号数据和私有验收记录保留在仓库外。不得复制主播端私有源码、模型或抠图模块来补齐本仓库测试。

## 双语维护

README、事件规范、测试指南和当前版本更新说明同时维护中文与英文，相互提供语言入口。两种语言使用同一份 Schema、代码、合成数据与 CI，不维护两个协议分支。字段名和枚举值保持英文且一致；新增行为须同时更新两份语义说明。其他既有中文专项文档在英文入口明确标注，不冒充已经全部翻译。
