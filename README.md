# paseo-pi-usage

在 Paseo 里查看 Pi 会话的累计 token 用量、上下文占用和当前模型供应商的账户余额。Paseo 原生 agent 快照中的 `lastUsage` 只有单轮用量，本插件通过读取 Pi session JSONL 汇总整个会话，并由服务端查询余额接口。

## 安装

插件 manifest 的要求为 **Paseo >=0.8.0**。需要已有 Pi agent；其他 provider 不显示 pill。

在本项目目录安装依赖，然后用本地目录安装插件：

```bash
npm install
paseo plugin install /absolute/path/to/paseo-pi-usage
paseo plugin ls                       # 确认插件为 running
paseo plugin logs paseo-pi-usage
```

修改插件源码或余额配置后，重新加载插件：

```bash
paseo plugin reload paseo-pi-usage
paseo plugin ls
```

## 展示形式

- **Composer pill**：Pi agent 输入框轨道栏显示 Gauge 图标、账户余额和上下文占比，例如 `$12.34 45%` 或 `¥12.34 45%`。余额保留两位小数，USD 使用 `$`，RMB / CNY 使用 `¥`；零余额也显示为 `$0.00` / `¥0.00`。余额未知显示 `—`，上下文未知或压缩后待更新显示 `?%`。
- **悬停 tooltip**：保留输入、输出、缓存命中率、会话花费（有值时）、上下文等用量摘要，并追加可用的账户余额。
- **点击 pill 打开弹窗（popover）**：弹窗锚定在 pill 上，头部有「刷新」和「关闭」按钮，点击外部也可关闭；副标题显示「会话：」及会话标题。
  - 顶部卡片依次为 **总 token → 上下文 → 余额**。
  - 上下文卡片显示占比、已用量与窗口大小，并展示进度条：超过 70% 为黄色，超过 90% 为红色。
  - 余额卡片大字显示当前余额，小字显示「余额 / 总额」，有有效总额时显示剩余比例进度条（余额除以总额，限制在 0%–100%）。余额或总额未知时对应位置显示 `?`；无有效总额时不显示剩余比例进度条。RMB / CNY 在卡片中使用 `￥`。
  - token 明细保留总 token 合计公式、输入、输出、缓存读、缓存写、思考，以及最近调用和全会话缓存命中率。
  - 会话信息包括模型、thinking level、LLM 调用数、用户轮次、压缩次数、开始与最后活动时间、session id。
  - 按模型拆分显示 token 用量；最近 40 次 LLM 调用按新到旧展示时间、模型和 token 明细，窄列下隐藏 R / ctx 列。这两处均不显示花费。
  - 底部显示 session 文件路径与大小。

账户余额来自余额接口，不是从会话花费中扣算出来的；卡片中的总额也来自接口，不由插件推算。

## 余额配置与查询

服务端默认读取 `~/.paseo/account-context.config.json`；可通过 **Paseo 服务端进程**的环境变量 `ACCOUNT_CONTEXT_CONFIG_FILE` 指定其他路径。配置在插件加载时读取，修改后需 reload。无需读取或向文档提交实际配置、API key 或其他凭证。

以下仅为配置结构示例，`example.invalid` 和 `REPLACE_WITH_API_KEY` 都是占位符；接口地址及返回字段须按实际供应商文档填写：

```json
{
  "providers": [
    {
      "provider": "your-provider",
      "baseUrl": "https://example.invalid",
      "apiKey": "REPLACE_WITH_API_KEY",
      "probe": {
        "url": "{{baseUrl}}/usage",
        "method": "GET",
        "headers": {
          "Authorization": "Bearer {{apiKey}}",
          "User-Agent": "cc-switch/1.0"
        },
        "extract": {
          "remaining": "quota.remaining",
          "total": "total",
          "unit": "unit",
          "isValid": "isValid"
        }
      }
    }
  ],
  "timeoutMs": 8000,
  "cacheMs": 15000
}
```

配置与鉴权以 [`server/balanceConfig.ts`](server/balanceConfig.ts) 和 [`server/balanceProbe.ts`](server/balanceProbe.ts) 为准：

- 顶层支持 `providers` 和 `accounts` 数组，两者会合并。每条记录必须提供非空 `provider`、有效 URL `baseUrl` 和非空 `apiKey`。
- 按当前模型标识 `provider/model` 的第一个 `/` 前缀精确匹配 `provider`；必须恰好匹配一条记录。没有前缀、没有匹配或重复匹配时，余额不可用。
- `probe` 可省略，示例中的 URL、方法、请求头及提取路径就是默认值，**不代表所有供应商都支持该接口或响应结构**。
- `probe.method` 支持 `GET` / `POST`，当前实现不发送请求体。`probe.headers` 可配置实际接口所需的鉴权请求头；自定义 headers 会替换默认 headers，需要自行包含必要的鉴权项。
- URL 和请求头中的 `{{baseUrl}}`、`{{apiKey}}` 会在服务端替换；`baseUrl` 替换时去掉末尾一个 `/`。仅请求 HTTP / HTTPS URL，不允许 URL 内嵌用户名或密码，不跟随重定向。
- `extract.remaining` / `total` / `unit` / `isValid` 均为 JSON 字段路径，支持点号与数组下标，例如 `data[0].remaining`。`remaining` 必须是有限数值（允许 0），`total` 必须是大于 0 的有限数值，字符串数字不会自动转换。`unit` 应为非空字符串；USD、RMB、CNY 按上述货币符号显示，其他单位按原文字显示，不做汇率换算。
- `isValid` 对应字段缺失时允许继续提取；存在时必须严格为布尔值 `true`，否则余额不可用。
- `timeoutMs` 默认 8000，允许正整数且不超过 30000；`cacheMs` 默认 15000，允许正整数且不超过 300000。

配置缺失或无效、供应商未匹配、接口失败、超时或返回值不可用时，余额显示未知，token 统计仍可使用。排查时先确认模型前缀、唯一配置记录、鉴权请求头及响应字段路径，不要把真实凭证粘贴到日志、截图或 issue 中。

## Token 数据来源

1. `paseo.agents.ref(agentId).refresh()` → `persistence.nativeHandle` 提供 Pi session JSONL 的绝对路径（由 Paseo 记录），并拿到 `lastUsage.contextWindowMaxTokens` 与模型。
2. 回退方案：按 Pi 的编码规则 `--<cwd 把 / \ : 换成 ->--` 在 `~/.pi/agent/sessions/`（或 `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR`）下按 `*_<sessionId>.jsonl` 查找。
3. 增量解析 JSONL：只读上次之后新增的字节，按行聚合。

统计口径对齐 Pi 自身实现（`core/usage-totals.js` + `modes/interactive/components/footer.js`）：

- 累计范围 = 所有 assistant 消息 + 带 usage 的 toolResult + `compaction` / `branch_summary` 条目。
- 总 token = 输入 + 输出 + 缓存读 + 缓存写；思考 token 单独展示。
- 上下文 token = `usage.totalTokens || input + output + cacheRead + cacheWrite`（Pi 的 `calculateContextTokens`）。
- 压缩之后、下一次有效 assistant usage 之前，上下文显示为 `?`（`contextStale`）。
- `aborted` / `error` / 全零 usage 的 assistant 消息不参与上下文推导，但计入累计总量。
- 按模型拆分时 assistant 归到 `provider/model`，其余归到 `Tools/summaries`。
- `formatTokens` 使用 Pi footer 的分档：<1k 原样、<10k 一位小数 k、<1M 整数 k、<10M 一位小数 M、否则整数 M。

因为读的是 Pi session 文件，**历史轮次也算在内**，包括插件安装之前的部分。

## 刷新策略

- pill 用量：客户端每 2.5s 发起批量 RPC（`pi-usage.snapshot`，单批最多 40 个 agent，每轮最多 120 个）。运行中、初始化中或 2 分钟内活跃过的 agent 每轮刷新；安静的 agent 在 Paseo 报告状态或活动时间变化时重新读取。
- pill 余额：有用量快照后查询 `pi-usage.balance`，客户端查询间隔至少 15s；不依赖安静 agent 的 token 文件重新读取。
- 弹窗：运行中每 2s、空闲每 10s 刷新；「刷新」按钮重新获取用量、调用明细和余额，余额请求带 `refresh: true` 绕过服务端已完成的缓存。
- 余额服务：默认缓存 15s（包括不可用结果），请求默认 8s 超时；同一 agent 当前会话 / 模型的并发请求共用正在进行的查询，手动刷新也会复用在途请求。会话或模型切换后会清除旧余额，并通过服务端取消和客户端结果校验抑制旧结果；归档时清理余额状态。
- session 解析：`persistence` 解析结果缓存 120s，未找到 session 时只缓存 4s。每个 session 文件只读增量，reader 上限 200（LRU），调用明细在内存中保留最近 400 条，累计总量不受影响。

## 开发与验证

```bash
npm install
npm run typecheck
# 验证本项目的解析、展示和余额逻辑（显式指定测试文件）
npm run test -- --exclude 'plugins/**' server/sessionFile.test.ts server/resolve.test.ts shared/format.test.ts shared/balanceFormat.test.ts server/balanceProbe.test.ts server/balanceService.test.ts client/pills.test.ts client/panel.test.tsx
paseo plugin reload paseo-pi-usage
paseo plugin ls
paseo plugin logs paseo-pi-usage
```

手动检查：Pi 会话 pill 显示余额与上下文占比；悬停查看明细；点击检查三张卡片顺序、余额 / 总额与进度条；确认零余额仍显示、总额缺失不显示余额进度条；点击刷新并切换会话或模型，确认旧余额不会覆盖新结果。

原有验证记录：

- 用 Pi 自己的 `dist/core/usage-totals.js` 作为独立 oracle，对 5 个真实 session 文件逐字段比对 input / output / cacheRead / cacheWrite / cost，全部一致。最大的文件为 2.3MB、474 次调用、6160 万 token。
- 用真实 Paseo agent 记录跑通 `resolve → 增量解析 → snapshot/calls` 全链路。
- 解析器单测覆盖跨 refresh 不重复计数、半行（含 UTF-8 多字节被切断）缓冲、文件被截断后重置、坏行跳过、调用列表上限。

## 限制

- 只统计 `provider === "pi"` 的 agent；其他 provider 不显示 pill。
- Pi session 文件是追加写的树结构，本插件按文件线性顺序聚合，与 Pi footer 的累计口径相同。会话 rewind 或分叉后，分支上的重复条目会一并计入。
- 会话花费来自 Pi 写入 JSONL 的 `usage.cost`，插件只求和，不自行计算模型价格；无单价的模型可能记录为 0。该统计与账户余额是两个独立来源，当前卡片、按模型拆分与调用列表不展示会话花费，tooltip 在花费大于 0 时保留摘要。
- 上下文窗口大小来自 Paseo 的 `lastUsage.contextWindowMaxTokens`，缺失时回退到 `providers.listModels`，两者都拿不到就显示 `?`。
