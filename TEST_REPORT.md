# 公共发行包验收记录

版本：0.2.0。核验日期：2026-10-13。环境：Node.js 24.19.0，Linux；原生 fixture 使用 workerd 1.20261013.1。

## 已通过

- 干净公共副本安装锁定依赖，`npm run check`：108 项测试全部通过，0 失败、0 跳过。
- 单个自包含 ESM Worker 构建；动态导入确认 `default.fetch`；MCP manifest 校验。
- workerd 原生 Fetch fixture：复现旧的 receiver 错误，验证修复后能进行模拟发现；外部网络禁用。
- 新增区域配置的默认拒绝、精确格式、非法配置拒绝、日历范围、实例隔离及禁止跨白名单重定向。
- 身份／只读门禁、强 ETag、条件写冲突、UID 重试、完整性失败、回退边界、提醒、重复规则、历史上海和 Berlin DST 回归。
- 官方 npm 注册表依赖审计：0 已知漏洞。此结果为核验时的快照，不是永久无漏洞保证。使用 `npm run audit:deps` 复查。
- 发布前通用隐私／秘密规则扫描；独立核对私有源资料中提取的部署身份／URL，无匹配。
- 公共目录从允许公开的源码和合成测试文件重建，没有继承私有 Git 历史、部署清单、凭据或私有验收／恢复记录。

## 依赖修复与许可

公开整理期间，初始旧依赖审计提示风险；公共版本已升级并精确锁定 fast-xml-parser 5.11.2、esbuild 0.28.2。ical.js 继续固定 2.2.1。所有安装来自官方 npm 注册表，锁文件保留完整性摘要。新增传递依赖许可已补齐并嵌入 Worker。原有私有部署不属于本次公共版本的升级目标。

## 可重现检查

```sh
npm ci
npm run check
npm run privacy:scan
npm run audit:deps
```

可选，使用已安装的 workerd：

```sh
workerd test tests/workerd/config.capnp
```

本地默认构建不要求 Site ID；生产部署前运行 `npm run configure:site -- <真实返回的 ID>` 并重新构建，再运行 `npm run validate -- --for-deploy`。不要向公开仓库或 ZIP 加入绑定后的清单。

## 分发与隐私

完整 ZIP 含源码、锁文件、文档、测试、依赖许可证及无 Site ID 的预构建 Worker；不含 node_modules、Git 数据、`.env`、服务端秘密或私人部署记录。GitHub 源码无需预构建目录也可通过相同命令重建。

自动扫描采用有限的模式匹配，不能替代人工审查，不应据此承诺所有未来改动绝对不会包含敏感信息。Fixture 中的 example.invalid 账号、fixture.chatgpt.site、合成 UID 及编号区域节点均为测试数据。区域节点的测试批准不代表任何真实部署默认批准。

## 明确未验收

- 本公共 0.2.0 包没有用真实 Apple 凭据联网测试或部署到接收者 Site。
- 没有验证接收者的 Sites 功能、插件连接、账号权限或区域节点。
- 没有实际 Apple 设备通知送达验证。
- 本次公共包整理没有做浏览器视觉 QA。
- 没有验证非 Sites 平台上的生产认证部署。

请用 `DEPLOY_TO_SITES.md` 在自己的私有实例分别完成这些验收；不要将模拟成功或配置存在写成真实账号已连通。
