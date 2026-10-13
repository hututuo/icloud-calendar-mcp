# iCloud Calendar MCP

一个部署在私有 ChatGPT Site 中的 iCloud 日历 MCP 适配器。查询日历和空闲时间，安全创建／更新事件，支持日历提醒；不需要自备常驻服务器或模型 API Key。

**English:** An owner-bound iCloud CalDAV adapter with a stateless HTTP MCP endpoint, a Chinese status page, and conditional, retry-safe event writes. Designed for a private ChatGPT Site. The source is open; each deployment and its credentials must remain private. This is an independent project, not an Apple or OpenAI product.

> 开源代码不等于公开日历服务。本项目是单所有者部署：每个使用者创建自己的 Site、配置自己的账号。不要把一个配置了凭据的实例开放给其他人。

仓库：[hututuo/icloud-calendar-mcp](https://github.com/hututuo/icloud-calendar-mcp)。

## 快速开始

- 使用者：阅读 [从零部署到 Sites](DEPLOY_TO_SITES.md)。
- 交给 Agent：把本仓库或完整 ZIP 提供给 Agent，并让它先读 [AGENTS.md](AGENTS.md)。
- 开发者：Node.js 24+，在项目根目录运行：

```sh
npm ci
npm run check
npm run privacy:scan
```

测试全部使用虚构账号、事件及模拟 Fetch，不连接 Apple。构建产物为 `dist/server/index.js` 与 `dist/.openai/hosting.json`。本地检查无需 Site ID 或任何凭据；实际发布前必须绑定新建 Site 的真实 ID。

## 功能

| MCP 工具 | 功能 |
| --- | --- |
| `list_calendars` | 发现已认证账号中、符合配置范围的 VEVENT 日历 |
| `list_events` | 指定时间范围内的事件／重复实例，包括资源 ID、ETag、提醒和参与者信息 |
| `freebusy` | 合并忙碌区间，不返回事件标题，排除透明或取消事件 |
| `create_event` | 稳定 UID、条件创建、幂等重试和写后读取 |
| `update_event` | 使用最新强 ETag 条件更新，只修改明确提供的字段 |

- 新建：上海时区或 UTC，带明确偏移和秒的 ISO 时间；支持全天事件（结束日不包含）。
- 日历提醒 `reminders: [10, 0, -5]`：开始前 10 分钟、开始时、开始后 5 分钟。不是 Apple「提醒事项」任务。
- 更新省略 `reminders` 时保留现有闹钟；`[]` 清除；给出数组则删除主事件的全部现有 VALARM（包括非 DISPLAY 类型），再创建指定的 DISPLAY 闹钟。
- 不删除事件，不发送参与者邀请，不更新已有 ATTENDEE／ORGANIZER 的事件。
- 重复事件只允许 `scope: "series"` 修改主事件元数据／提醒；不允许单次实例修改或整组时间／规则改写。

## 安全设计

- 默认只读；仅字面值 `WRITE_ENABLED=true` 才开启写工具。技术开关不代替用户对实际日历改动的授权。
- 使用 Sites 可信入口注入的登录身份，并精确匹配 `OWNER_USER_ID`。未绑定时所有日历数据工具失败关闭。
- 凭据只在服务端。浏览器页面没有密码输入框，只显示配置布尔值和当前 Site 的登录 subject。
- 不将凭据写入源码、构建产物、仓库、日志或 MCP 参数。
- 只允许 HTTPS Apple CalDAV 目标；限制重定向、日历范围和事件资源。区域节点必须显式配置，默认全部拒绝。
- 创建使用 `If-None-Match: *`；更新使用强 ETag 和 `If-Match`。无法判断写入结果时停止并要求读取核对。
- GET 缺少可靠 ETag 时，可使用同一事件的有界 REPORT 读取配对正文和 ETag；不会无条件覆盖。
- XML 外部实体／DTD、路径穿越、账号外资源、部分读取结果均拒绝。freebusy 不会把错误结果当成空闲。
- 不申请数据库／对象存储。托管平台仍处理运行时数据；遵守其条款及敏感数据限制。

**重要：不要原样把此 Worker 发布到公共 Workers 域名。** 代码信任 Sites 注入的身份头。离开可信入口后，客户端可能伪造该头；其他平台必须先重做认证与可信入口隔离。详见 [安全说明](SECURITY.md)。

## 运行时配置

`.env.example` 仅说明键名，程序不会自动加载该文件。使用托管平台的服务端环境变量／Secrets。

| 键 | 内容与默认行为 |
| --- | --- |
| `OWNER_USER_ID` | 在当前 Site 内，可信登录后状态页显示的 subject；不是邮箱，不是其他 Site 的 ID |
| `CALDAV_USERNAME` | Apple 账号登录名，仅服务端 |
| `CALDAV_PASSWORD` | Apple 应用专用密码，不能使用账号主密码 |
| `CALDAV_ALLOWED_CALENDAR_URLS` | 可选 JSON 字符串数组，只填真实发现的完整日历 URL；未设置=账号内发现的日历，`[]`=全部拒绝 |
| `CALDAV_ALLOWED_REGIONAL_HOSTS` | 可选 JSON 字符串数组；默认 `[]`。仅接受精确编号的 `pNN-caldav.icloud.com.cn` 形式，最多 20 个；不支持通配符、URL、端口、其他域名 |
| `WRITE_ENABLED` | 默认 `false`；只读验收和写入授权后才设为 `true` |

全球节点 `caldav.icloud.com` 及 1–3 位数字的 `pNN-caldav.icloud.com` 已有内置限制。中国区域节点没有内置批准值。遇到 `UNSAFE_URL` 时，先核对来自 Apple 已认证发现过程的 host，再由所有者批准那一个确切凭据目的地。不要把测试 fixture 的节点复制到自己的配置。

## 边界与兼容性

- MCP：`POST /mcp`，JSON-RPC 2.0，支持 `initialize`、`ping`、`tools/list`、`tools/call` 及通知 202；协议 `2025-11-25`／`2025-06-18`；无 GET/SSE、会话状态或旧版批处理。
- 新建定时事件年份：1992–2100。读取浮动／全天时间以 Asia/Shanghai 解释。
- 保留已有 VTIMEZONE、未知属性、Apple 属性、UID、异常实例及未修改提醒；保留是语义层面的，不承诺原始折行／排序字节相同。
- 有界支持 DAILY/WEEKLY/MONTHLY/YEARLY 常用规则；复杂 RRULE、EXRULE、RDATE period、RANGE=THISANDFUTURE 等拒绝，绝不静默截断。
- 支持测试覆盖的上海历史时区与 Berlin DST；未知／不支持的时区明确报错，不猜成 UTC。
- 100 日历、366 天查询窗口、250 个 REPORT 资源、2,000 个展开实例、100,000 个日期扫描预算；请求 64 KiB、ICS 256 KiB、XML 4 MiB；单次上游 20 秒，发现阶段最多 3 次重定向。

完整限制以工具 schema 和测试为准。读取规模过大时缩小日期范围；UID／更新回退涉及完整日历时，需要使用较小的专用日历，不要放宽安全边界。

## 可选扩展：Bark 手机推送

即时手机推送放在独立的 [Bark Notification MCP](https://github.com/hututuo/bark-notification-mcp) 仓库；本日历仓库不捆绑 Bark 源码，也不会自动开启推送。需要时按其[组合部署指南](https://github.com/hututuo/bark-notification-mcp/blob/main/docs/DEPLOYMENT.md)接入已有 MCP，保留原 owner 鉴权、日历凭据和写入开关。

Bark 设备 key 只配置在服务端，默认禁用，测试须经设备所有者同意。优先发送低敏通用信号；正文会经过公共 Bark 服务和 Apple APNs，并可能显示在锁屏。普通推送不是 iPhone「时钟」闹钟，API 接受不代表手机收到，也不提供可靠定时或送达保证。

## 版本与验收

`0.2.0` 是公共发行版本：基于 `0.1.10` 的日历核心，移除了部署身份及私有记录，新增每实例区域节点配置、可复现构建和公开部署指南。它不包含任何可用账号、部署授权或真实日历导出。

[测试与隐私检查报告](TEST_REPORT.md) 记录公共副本的实测结果。自动化测试不能证明接收者 Apple 账号连通、手机通知已送达或第三方托管部署安全；这些必须按部署指南逐项验收。

## 文件与许可

- `worker/`：HTTP/MCP 入口与身份边界
- `src/`：CalDAV、iCalendar、重复规则、页面
- `tests/`：合成 fixture 与安全／兼容性回归测试
- `scripts/`：构建、Site 绑定、产物校验与发布前扫描
- `.openai/hosting.example.json`：无部署身份模板
- `DEPLOY_TO_SITES.md`、`AGENTS.md`：使用者及 Agent 操作指引

本项目原创代码采用 [MIT](LICENSE)。第三方依赖各自保留许可，尤其 `ical.js` 是 MPL-2.0；整个打包 Worker 不能被描述为纯 MIT。参见 [第三方声明](THIRD_PARTY_NOTICES.md)。无担保，请先在专用测试日历验收。
