# 从零部署到 ChatGPT Sites

适用于第一次拿到本仓库／ZIP 的使用者与 Agent。代码版本：0.2.0。平台界面与能力会变化；以下公开资料核对日期为 2026-10-13。

## 0. 先确认你能用 Sites

你需要：

- 自己的 ChatGPT 账号，以及当前账号／工作区已开放的 Sites 创建和发布权限。
- 能使用 Sites 工具的 ChatGPT／Agent 环境；只有普通终端或拿到 ZIP，并不自动获得 Sites 发布能力。
- Apple 日历账号与应用专用密码；苹果要求该账号开启双重认证。用户本人生成和输入密码。[Apple 官方说明](https://support.apple.com/en-us/102654)
- Node.js 24+、npm 和 Bash（Linux、macOS 或 Windows WSL）。安装依赖时能访问官方 npm registry。

在 ChatGPT 中可从 Work 或支持的桌面入口请求创建网站；可用性以你的账户及管理员设置为准。[官方 Sites 入门](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites)

**没有 Sites 权限／工具时：** 仍可完成下述本地测试和构建，但应停在部署步骤并清楚说明缺少的能力。不要虚构一个 `sites deploy` 命令、公共发布 API 或可用网址；也不要把身份检查移除来换取“跑通”。其他 Worker 平台只属于文末的移植开发路线。

## 1. 获取源代码，先离线逻辑验收

```sh
git clone https://github.com/hututuo/icloud-calendar-mcp.git
cd icloud-calendar-mcp
npm ci
npm run check
npm run privacy:scan
npm run audit:deps
```

也可解压完整 ZIP，在含 `package.json` 的目录执行安装和检查命令。首次 `npm ci` 需下载锁定依赖；测试本身不访问 Apple。没有 npm 默认缓存写权限时，可改用自己有写权限的目录：

```sh
npm ci --cache ./node_modules/.npm-cache
```

确认：全部测试通过；生成的 `dist/server/index.js` 是单个 ESM，导出 `default.fetch`；`dist/.openai/hosting.json` 有 `capabilities: ["mcp"]`、`d1: null`、`r2: null`，尚无 project ID。模板本来就不含任何可用部署身份。

可选原生 Worker fixture（先通过官方 npm registry 安装当前支持的 workerd；这是额外开发依赖，需遵守你的安装权限）：

```sh
workerd test tests/workerd/config.capnp
```

此 fixture 将所有外部访问转到虚构服务；不会连 Apple。它验证真实 Fetch 调用约定，不代替账号验收。

## 2. 新建你自己的私有 Site

向有 Sites 能力的 Agent 明确说明：

> 请用这个仓库创建属于我的私有 ChatGPT Site，保留单个 Worker ESM 和 MCP 能力。先完成本地检查，再部署未配置凭据的版本。不要复用其他人的 Site ID，不要公开 Site，不要收集我的密码；运行时配置由我在可信 Settings 中输入。先保持只读。任何另开执行任务的行为遵守我另外给你的授权。

Agent 使用当前平台正式的“创建 Site”流程；保留实际返回的 ID，核实所有权和仅所有者访问范围。保存版本与部署是不同动作，每一个正式部署 URL 都应按生产地址对待。[Sites 项目与版本说明](https://learn.chatgpt.com/docs/sites)

将真实 ID 写入本地部署清单：

```sh
npm run configure:site -- YOUR_RETURNED_PROJECT_ID
npm run build
npm run validate -- --for-deploy
```

`YOUR_RETURNED_PROJECT_ID` 是占位符，必须替换为刚才的返回值。脚本会从 `.openai/hosting.example.json` 生成 `.openai/hosting.json`；若已有不同 ID 则拒绝覆盖。

- 公共仓库始终保留无 ID 模板；`.openai/hosting.json` 被 Git 忽略。
- Agent 为部署建立独立的私有工作副本，使用当前 Sites 源码流程关联该 Site 的私有源码仓库。先核实 Git 目标确实是该私有仓库而非公共 GitHub，再在私有副本中显式跟踪 `.openai/hosting.json`（必要时 `git add -f .openai/hosting.json`），之后进行平台源码同步／打包。不要在公共工作树强制跟踪这个文件，不把绑定后的内容推回公共仓库。
- 产物不是静态网页：必须保留 `dist/server/index.js` 和 `dist/.openai/hosting.json`；不要把 Worker 当普通 `index.html` 上传。
- 通过正式“保存版本并私有部署”流程发布；只报告工具实际确认的版本、部署终态和 URL。不能把 ZIP 已生成当作已发布。
- 本仓库不捆绑平台凭据或平台专用发布程序。Agent 必须使用其当前真实可用的 Sites 工具及其参数说明完成上述平台步骤。

## 3. 安全绑定所有者与 Apple 账号

1. 用所有者账号通过刚发布 Site 的正常登录入口打开首页。页面只显示状态，不请求日历。
2. 页面“当前登录身份”或同一 Site 的 `/api/status` 返回 `authenticated_subject`。把这个值作为当前部署的 `OWNER_USER_ID`。不能用邮箱、其他 Site 的值，或把全局账号 ID 当作它。
3. 用户本人打开 Sites → 该 Site → More actions → Settings，输入服务端环境变量／Secrets。密码不要贴到聊天或项目文件中。公开平台说明支持在此管理运行时值，变更后需要重新部署保存的版本。[运行时配置说明](https://learn.chatgpt.com/docs/sites)
4. 填入以下键。初次保持只读，且不预先猜日历 URL／区域节点：

| 键 | 初次设置 |
| --- | --- |
| OWNER_USER_ID | 当前 Site 实际显示的 subject |
| CALDAV_USERNAME | 你的 Apple 登录账号 |
| CALDAV_PASSWORD | 你为这个连接生成的应用专用密码 |
| WRITE_ENABLED | `false` |
| CALDAV_ALLOWED_REGIONAL_HOSTS | `[]` 或不设置 |
| CALDAV_ALLOWED_CALENDAR_URLS | 初次发现可不设置；发现后限制到选定日历。若先设 `[]`，发现列表会为空 |

5. 保存后重新部署刚批准的代码版本，使变更生效。页面变为“已配置，等待真实验收”只说明键已存在，不证明账号连接成功。
6. 如果没有可信 Secrets 输入界面，停在未连接状态。不要在终端参数、MCP 参数、截图、`.env` 附件或聊天里传密码。你可以先检查并使用当前平台实际支持的安全输入入口。

应用专用密码只应给予托管此实例的平台，并在限定目标上用于访问 Apple CalDAV；配置持久访问前应确认这个数据流。公开源码许可证不会替你授予 Apple 或 Sites 账号访问权。

## 4. 安装和连接 MCP 插件

Site 具备 MCP 能力并发布后，使用平台为该 Site 提供的插件卡片／连接入口，选择 Install，完成自己的 Connect 流程。不要随意新增一个指向未保护 Worker 的通用 MCP URL。

在支持的聊天中选择这个插件，先调用 `initialize`／`tools/list`，确认五个工具，然后调用 `list_calendars`。发现 schema 成功不代表日历权限成功。[官方 MCP 插件托管与连接流程](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites)

本适配器端点为你的 Site 地址下的 `/mcp`，使用无状态 HTTP POST。不提供 GET/SSE。协议行为以仓库 `worker/index.js` 和 [MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 为参考。不要把“手工伪造身份头的 curl 成功”当成生产登录验收。

## 5. 先只读验收，再缩小账号范围

1. 调用 `list_calendars`，检查真实返回值。选择你自己的一个专用测试日历；记住返回的完整 `calendar_id`，不要自己拼账号路径。
2. 将 CALDAV_ALLOWED_CALENDAR_URLS 设置为仅包含该 URL 的 JSON 数组，保存并重新部署。再次调用列表，确认只有这个日历。
3. 在测试日历已有事件的短范围内调用下列工具；时间请换成你准备核对的实际日期：

```json
{
  "calendar_id": "<list_calendars 返回的完整值>",
  "start": "2030-01-15T00:00:00+08:00",
  "end": "2030-01-16T00:00:00+08:00"
}
```

这组参数适用于 `list_events` 和 `freebusy`。在 Apple 日历中人工核对时间、全天结束日与提醒；确认 freebusy 区间符合预期。空结果只能说明该范围内没有返回事件，不能证明它查对了日历。

4. 独立核对未登录者、不同身份不能取得日历数据。通过用户正常登录／登出及平台访问控制来验证，测试环境可额外使用合成身份；生产不要削弱认证。
5. 若错误为 `UNSAFE_URL`，只会给出 host／协议／端口／阶段等受限诊断。先确认 host 来自 Apple 已认证发现，再由所有者批准确切 regional host。CALDAV_ALLOWED_REGIONAL_HOSTS 的值必须是 JSON 数组，元素是精确的编号 `pNN-caldav.icloud.com.cn` 主机名，不能写协议、路径、端口或通配符；保存后重新部署。公开测试节点全是 fixture，不能拿来配置你的账号。

## 6. 经明确授权后，验证创建与同资源更新

在开始前由所有者确认：允许对哪个测试日历创建哪一个事件、日期时间、提醒，以及随后修改的具体内容。开启写入不表示允许任意改动。

1. 将 WRITE_ENABLED 设置成字符串 `true`，保存并重新部署。
2. 为这次唯一的创建意图生成一个 UID，保存在你自己的私有验收记录中。可用 `node -p "crypto.randomUUID() + '@example.invalid'"` 生成；重试绝不生成新 UID。
3. 调用 `create_event`，替换所有占位符和示例日期：

```json
{
  "calendar_id": "<已选定测试日历>",
  "uid": "<这次创建的稳定唯一 UID>",
  "summary": "MCP 连接测试",
  "start": "2030-01-15T09:00:00+08:00",
  "end": "2030-01-15T09:30:00+08:00",
  "all_day": false,
  "timezone": "Asia/Shanghai",
  "reminders": [10, 0, -5]
}
```

4. 用 `list_events` 再读该时间范围，确认同一 UID 只对应预期事件，标题、起止时间和三次提醒正确；在 Apple 日历里核对。
5. 每次更新前，从新的 `list_events` 结果中取得该资源 `event_id` 和强 `etag`。不要拿创建／更新返回的弱 ETag（以 `W/` 开头）继续写。
6. 用以下参数调用 `update_event`。`expected_etag` 是返回的完整字符串，保留双引号内容与 JSON 转义；不得手工编造。

```json
{
  "calendar_id": "<同一个测试日历>",
  "event_id": "<list_events 返回的同一资源>",
  "expected_etag": "<最新强 ETag>",
  "scope": "event",
  "patch": { "summary": "MCP 连接测试（已更新）" }
}
```

7. 再读取，确认 UID／资源保持一致，标题已变，未指定的起止时间和提醒保持不变。重复事件用 `scope: "series"`，且仅允许元数据／提醒修改。
8. 如需测试通知是否到达，选未来适当时间，并让用户确认 Apple 设备通知权限、日历提醒设置与实际弹出结果；MCP 读回正确不能证明手机收到通知。
9. 最后保留还是关闭写入由所有者决定。只做验收时建议恢复 `WRITE_ENABLED=false` 并重新部署。适配器没有删除工具，测试事件由所有者在 Apple 日历中自行清理，或另行明确授权其支持的管理方式。

### 重试原则

- 创建超时／WRITE_RESULT_UNKNOWN：沿原 UID 和资源读取确认；仍需重试时，原 UID 与原创建参数都不改变。
- 更新超时：先重新读取并核对实际状态，不能盲用旧 ETag 再发 PUT。
- ETAG_CONFLICT：重新 list_events，展示新状态并重新确认意图；绝不改成无条件 PUT。
- 若上游已确认写入，但时区无法验证：可能已成功保存。不要换 UID 重建。

## 7. 常见问题

| 现象 | 检查／处理 |
| --- | --- |
| npm 缓存无权限 | 使用有写权限的 `--cache` 路径；不要改系统权限 |
| 构建通过但没有 Site | 本地构建不发布；检查 Sites 权限与正式发布步骤 |
| 401 / UNAUTHENTICATED | 经该 Site 的可信登录入口访问，完成对应插件连接 |
| 403 / FORBIDDEN | 当前 Site subject 与 OWNER_USER_ID 不一致；核对实际登录，不关闭验证 |
| OWNER_NOT_CONFIGURED | 安全设置当前 Site 的正确所有者，重新部署 |
| NOT_CONFIGURED | 键缺失或 JSON 数组非法；不输出凭据进行调试 |
| ICLOUD_ACCESS_DENIED | 用户检查 Apple 账号和应用专用密码是否有效；主密码变更可能使应用专用密码失效 |
| 日历列表为空 | 检查是否设置了 `[]`，范围是否是发现的精确 URL，是否为 VEVENT 日历 |
| UNSAFE_URL | 核实受限 host 诊断与来源；不扩大为任意域名 |
| WRITES_DISABLED | 先完成只读验收、用户授权、设置 true，再重新部署 |
| ETAG_REQUIRED / ETAG_CONFLICT | 从新的 list_events 获取强 ETag；检查并发修改，保持条件写 |
| INCOMPLETE_DAV_RESPONSE | 上游有不可读／不完整行；不返回部分结果，不据此声称有空闲 |
| TOO_MANY_EVENTS / TOO_MANY_OCCURRENCES | 缩小查询时间；完整 UID／ETag 回退扫描过大时使用较小专用日历 |
| UNSUPPORTED_TIMEZONE / RECURRENCE | 保存脱敏错误分类，用合成 fixture 开发明确兼容；不猜时区、不忽略规则 |
| GET /mcp 返回 405 | 正常：此实现只提供无状态 POST |
| 状态页仍说“等待真实验收” | 正常：页面不会把配置存在误报为已通过真实账号测试 |
| 手机上无提醒 | 先核对 ICS 提醒，再由用户检查设备权限；服务端写入成功不等于通知送达 |

## 8. 升级、恢复与移植

升级同一个 Site：保留自己的 Site ID 和私有设置，先跑完整测试，保存新版本，再经授权部署；出问题时部署之前通过验收的保存版本。配置变化也需要重新部署。不要把任何账号值或部署 manifest 回传到公共仓库。公开 ZIP 足够重建通用代码，但不含你自己的账号配置或服务端秘密。

另一个人部署：从无 ID 公共副本开始，重复以上步骤。绝不复制他人的 OWNER_USER_ID、日历 URL 或凭据。

通用 Worker 移植：核心为标准 Fetch API 与 `default.fetch`，没有数据库，技术上可移植到兼容运行时；但 Sites 登录、可信身份注入、私有入口和 MCP 插件连接需要替代实现。必须先完成 `SECURITY.md` 的认证改造、Secrets 配置与未授权访问测试，才能对外运行。[Cloudflare Fetch handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/) 与 [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) 是通用平台参考，本仓库没有一键 Cloudflare 生产配置。

## 给使用者的验收记录

请在你自己的私有记录中填写，不提交到公共仓库：

- 使用的源码版本／提交，测试及构建结果
- Site 地址、访问范围、部署版本和运行时配置是否生效
- 所有者绑定与未授权访问检查
- MCP 插件安装／连接、真实日历发现、窄范围读取
- 若获授权：单个稳定 UID 创建、强 ETag 更新、最终读取
- Apple 设备提醒：通过／失败／未测试
- 写入最终状态、未完成项及下一步
