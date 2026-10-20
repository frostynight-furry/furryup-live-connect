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
