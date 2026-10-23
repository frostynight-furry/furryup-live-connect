# 参与 FurryUP LiveConnect

欢迎修复协议适配、完善四平台的真实能力、补充文档和合成测试。提交前请先在 Issue 中说明可复现的问题；小修复可直接提 PR。

## 验证

使用 Node.js 22.12+、JDK 21+ 和 Maven 3.9+，执行：

```sh
npm run build
npm test
```

纯 Node 变更可以先运行 `npm run test:core`、`npm run test:wechat` 与 `npm run test:examples`。`npm run demo` 可离线体验四平台合成事件。新增源码还须更新 `scripts/audit-source.cjs` 的逐文件白名单，暂存后运行 `node scripts/audit-source.cjs --tracked` 检查实际 Git 文件。CI 在 Windows / Linux、Node.js 22 / 24 上构建和测试，不连接真实直播间。

阅读 [API 文档](docs/API.md) 理解字段和资源生命周期，[路线图](docs/ROADMAP.md)区分协议线索与实际支持。请通过仓库 Issue 表单提交问题或功能建议，PR 使用对应模板记录行为与验证。欢迎贡献[社区案例](docs/SHOWCASE.md)。

## 数据语义

- 区分礼物增量与连击总量、当前在线与累计观看、点赞信号与精确次数。
- 缺失字段保留未知；不从昵称、首次发言或人数变化推断身份和进出场。
- 使用平台、房间、可靠用户 ID 隔离头像缓存；匿名或隐藏身份不参与公开资料补全。
- 新解析请附合成 fixture、字段依据与已验证范围。真实协议样本须先去掉账号、凭据和个人信息，尽量改写为合成样本。
- 引入第三方代码时附原始来源、固定提交及许可证，保留必要声明。调研过的项目不等于可直接复制的实现。

请勿提交 Cookie、登录会话、访问令牌、实际观众记录、平台后台页面源码或产品私有文件。安全问题请参考 [SECURITY.md](SECURITY.md)。

贡献遵循仓库的 MIT 许可证；FurryUP Studio 和其他产品未包含在该源码许可中。

## 事件与双语文档

新增事件语义先更新 [事件规范](docs/EVENTS.md) / [English contract](docs/EVENTS.en.md) 和对应 Schema，再添加合成用例及行为测试。用 npm run test:events 和 npm run replay 检查去重、乱序、房间及生命周期边界。

README、事件规范、测试指南与当前更新说明中英文同步；字段及枚举不翻译成另一套协议。参见 [测试指南](docs/TESTING.md) / [English testing guide](docs/TESTING.en.md)。任何真实抓包、Cookie、观众资料或主播端私有文件都不得混入 fixtures。暂存后审计会读取实际 Git blob，必须与审核过的工作副本一致。
