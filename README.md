# dsh-context-watch

> 上下文快满的时候，替她说一声。
> Warns an agent before its context window fills up.

---

## 中文

### 它解决什么

DSH 的会话不会突然断，它是**慢慢涨满的**。

等你发现的时候，往往已经晚了：窗口塞爆，模型开始超时，agent 卡在那儿，
连一句「我要不要写个交接」都说不出来。

这个插件做一件事：**在还有余力的时候，喊一声。**

它会告诉 agent：

```
[上下文提醒] 已用 820k / 1.00M（82%），还剩 180k。
建议尽快整理交接信息：没做完的事、重要的约定、下次醒来第一件要做的事。
```

带上**现在多大、上限多少、还剩多少** —— 够它判断还有没有时间把话说完。

### 它不做什么

- **不常驻轮询**。只在会话事件里读一次用量，零额外开销。
- **不一直报**。每个阈值、每个会话只喊一次。
- **不占上下文**。提醒本身是一条消息，除此之外没有任何注入。

### 原理

```
agent 每说一句话
   ↓
DSH 往会话日志里写一条 assistant/message，带 usage
   ↓
插件从 usage 算出：inputTokens + cacheReadTokens + cacheWriteTokens
   ↓
除以模型的 contextWindow，得到占比
   ↓
第一次跨过 80% / 92% → 往 agent 的 next-turn 收件箱塞一条提醒
```

上限从模型信息（`context.contextWindow`）自动读取，读不到就用 `fallbackContextWindow`。

### 安装

**方式一：装进 profile（推荐）**

```bash
cd <你的 DSH profile 目录>/node_modules
git clone https://github.com/HanyuReo/dsh-context-watch.git
```

然后在同一个 profile 的 `cordis.patch.yml` 末尾加：

```yaml
- id: context-watch
  name: 'dsh-context-watch'
  config:
    thresholds: [0.8, 0.92]
```

重启 DSH。

**方式二：跟着 bundle 走**

`package.json` 里已经声明了 `dsh.bundle.patch`，宿主会在加载 bundle 时自动读
`cordis.patch.yml`，不需要手工加配置行。

### 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `thresholds` | `[0.8, 0.92]` | 提醒阈值（0~1）。每个阈值、每个会话只提醒一次 |
| `contextWindow` | `0` | 上下文上限。`0` = 自动从模型信息读取 |
| `fallbackContextWindow` | `1000000` | 读不到模型上限时的兜底值 |
| `notifyAgent` | `true` | 是否把提醒塞进 agent 的下一轮 |
| `logToConsole` | `true` | 是否在 DSH 控制台打印 |
| `template` | 见源码 | 提醒文本模板 |

模板可用变量：`{{used}}` `{{limit}}` `{{percent}}` `{{remaining}}` `{{threshold}}`

想让它闭嘴只打日志：

```yaml
config:
  notifyAgent: false
  logToConsole: true
```

### 注意

- **提醒会触发一轮回答**。这是它的代价，也是它的意义——她只有被叫醒才能写交接单。
  不想要就用 `notifyAgent: false`。
- **每个阈值只喊一次**。会话被压缩后总量会回落，但提醒不会重复。
- **依赖 DSH 内部接口**（`session/event`、`agent.inbox.append`、`ctx.llm.resolveModel`），
  目前对照 `dsh-agent-loop` / `dsh-session` 的实现写的。DSH 大版本升级后可能要跟着改。
- 只测过 DeepSeek Harness 桌面版（0.2.x 系列）配 `deepseek-flash`。

### 许可

MIT。

---

## English

### The problem

A DSH session doesn't die suddenly — it fills up slowly. By the time you notice,
the window is already full, the model starts timing out, and the agent is stuck
mid-thought with no chance to write anything down.

This plugin does one thing: **it speaks up while there is still room.**

```
[context] 820k / 1.00M used (82%), 180k left.
Consider writing down what's unfinished while you still can.
```

### How it works

1. DSH appends an `assistant/message` record after every model call, carrying `usage`.
2. The plugin computes `inputTokens + cacheReadTokens + cacheWriteTokens`.
3. It divides by the model's `context.contextWindow` (auto-detected, with a fallback).
4. On the first crossing of each threshold, it drops one message into the agent's
   `next-turn` inbox — exactly like a user message, and only once per threshold.

No polling, no timers, no extra context beyond that single message.

### Install

```bash
cd <your DSH profile>/node_modules
git clone https://github.com/HanyuReo/dsh-context-watch.git
```

Then append to that profile's `cordis.patch.yml`:

```yaml
- id: context-watch
  name: 'dsh-context-watch'
  config:
    thresholds: [0.8, 0.92]
```

Restart DSH.

### Config

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `thresholds` | `[0.8, 0.92]` | fractions of the window to warn at (once each per session) |
| `contextWindow` | `0` | override the limit; `0` = auto-detect |
| `fallbackContextWindow` | `1000000` | used when the model doesn't report a limit |
| `notifyAgent` | `true` | inject the warning into the agent's next turn |
| `logToConsole` | `true` | also print to the DSH console |
| `template` | see source | message template |

### Caveats

- The warning **costs one turn** — that's the point: someone has to be woken up
  to write the handover. Set `notifyAgent: false` for log-only mode.
- It relies on DSH internals (`session/event`, `agent.inbox.append`,
  `ctx.llm.resolveModel`) as implemented in `dsh-agent-loop` / `dsh-session`.
  A major DSH upgrade may require adjusting it.
- Tested on the DSH desktop build (0.2.x) with `deepseek-flash` only.

### License

MIT.
