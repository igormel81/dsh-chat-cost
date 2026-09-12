# dsh-chat-cost

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Web UI 显示每个对话的 token 费用：本对话、其子代理以及整棵会话树，价格来自内置的多供应商目录，并把只追加的 JSONL 费用日志写入你的项目目录。

[English](README.md) | 中文 | [Русский](README.ru.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blueviolet)](#安装)
[![providers](https://img.shields.io/badge/providers-7%20%C2%B7%20139%20models-informational)](#计价规则)

**关键词：** DeepSeek Harness 插件、dsh 插件、dsh-plugin、token 费用、单次对话费用、子代理费用、会话树费用、LLM 花费统计、token 用量、费用日志、JSONL、本地优先、DeepSeek V4.1 Flash、DeepSeek V4 Pro、OpenAI GPT-5、Anthropic Claude、Google Gemini、Kimi K3（Moonshot）、xAI Grok、Mistral、缓存读取与写入计价、峰谷计价、Cordis 插件。

## 状态

已完成：价格目录、计价引擎（峰谷时段、缓存读取与写入规则）、遍历会话树并为每个会话计价、写入 JSONL 费用日志的宿主端、预算规划工具（`cost_price`、`cost_history`、`cost_estimate`、`cost_plan`、`cost_mark`），以及英语、中文、俄语的客户端读数。

已知限制（明示而非隐藏）：只有活动会话会暴露供应商用量，因此仅存在于持久化存储中的子代理会话会被列出但没有价格；部分 Gemini 与 Grok 模型公布的长上下文档位价格尚未应用。

## 配置

```yaml
- id: dsh-chat-cost
  name: dsh-chat-cost
  config:
    writeLog: true        # 将 JSONL 费用日志写入项目目录
    logDir: .dsh-cost      # 项目目录中的子目录名
    language: en          # en | zh | ru；省略则跟随 harness 语言设置，其次为浏览器语言
    ledgerTailBytes: 2097152  # 每次汇总回读的日志字节数（2 MiB）
```

## 功能

- **多供应商价格。** 内置 [models.dev](https://models.dev) 目录快照，覆盖七个供应商——DeepSeek、Moonshot、OpenAI、Anthropic、Google、xAI、Mistral——及其全部有价模型（当前 139 个）。
- **诚实的计算。** DeepSeek 使用其官方价格表并区分峰谷时段；缓存写入在有独立价格的供应商（Anthropic、OpenAI）按缓存写入价计费，否则按输入价计费；没有价格的模型显示 `—`，绝不编造数字。
- **按对话、子代理、会话树分级。** 悬停提示会分开显示本对话与其子代理，并给出会话树合计、token 明细与涉及的模型。
- **项目目录中的费用日志。** `<project>/.dsh-cost/cost.jsonl`，每个会话每次落盘一行 JSON，包含会话树位置、四项 token 统计、累计与增量费用以及价格来源。在 git 工作树中，首次写入时会把 `.dsh-cost/` 加入项目的 `.gitignore`；普通目录不做任何改动——日志可以写入，但不留下多余文件。
- **按区间计价。** 以 JSONL 日志为准：每次落盘只对上次记录之后新增的 token 按当时生效的价格计费。跨过 DeepSeek 峰时边界的对话保留实际计费价格，不会被追溯重算。
- **有界读取与缓存。** 汇总只读取日志尾部（`ledgerTailBytes`，默认 2 MiB），并在文件大小与修改时间未变时复用缓存；若尾部从文件中间开始，插件会报告 `truncated` 与 `skippedBytes`，而不是假装掌握全部历史。
- **不会悄悄漏账。** 未归入任何计划单元的费用会在提示中点名（`$1.230 未归入任何计划单元`），而不是混进合计。
- **三种语言。** 英语、中文、俄语，依次按插件配置、harness 语言设置、浏览器语言选择。

## 安装

```sh
dsh plugin --profile web add dsh-chat-cost
```

本包是 DSH bundle：profile 会自动合并它的补丁层（声明了 `dsh.bundle` 的依赖会自动加入 `dsh.profile.bundles`），无需手工编辑补丁。安装后重启宿主。

## 计价规则

| 规则 | 行为 |
| --- | --- |
| DeepSeek | 官方价格表；工作日 01:00-04:00 与 06:00-10:00 UTC 为峰时，价格翻倍；缓存写入无单独费用，按输入价计费 |
| 其他供应商 | 内置 models.dev 快照，缓存读取与写入价完全按公布值使用 |
| 未公布缓存读取价 | 回退到输入价，即上界 |
| 未知模型 | 解析为无价格；读数显示 `—`，提示中会列出该模型 |
| 归属 | 以日志为准：已记录区间保留当时价格，只对新增 token 计费 |

使用 `npm run prices`（七个精选供应商）或 `npm run prices:all`（目录中的全部供应商）刷新快照。

### 数字如何得出

汇总以日志为基础：已记录的增量直接由文件求和，只有最后一条记录之后的 token 才按当前价格计费。因此跨峰时边界的对话显示的是实际花费，而不是被追溯翻倍的结果。

## 费用日志格式

```json
{"ts":"2026-09-12T20:00:00.000Z","plugin":"dsh-chat-cost@0.5.0","rootSessionId":"root-1","sessionId":"child-1","parentSessionId":"root-1","depth":1,"kind":"subagent","provider":"moonshot","model":"kimi-k3","pricingSource":"catalog","tier":"flat","tokens":{"uncachedInput":5000,"cacheRead":0,"cacheWrite":0,"output":1000},"totalTokens":6000,"deltaTokens":{"uncachedInput":1000,"cacheRead":0,"cacheWrite":0,"output":200},"deltaTotalTokens":1200,"cumulativeUsd":0.014,"deltaUsd":0.002}
```

## 发布流程

```sh
npm test            # 114 项测试；schema 检查需要 DSH profile 提供校验器
npm run prices      # 发布前刷新内置价格目录
npm version minor
npm publish --access public
for f in README.md README.zh.md README.ru.md; do echo "$f: $(git hash-object $f)"; done
```

本包是 DSH bundle：`dsh plugin --profile web add dsh-chat-cost` 即可安装，profile 会自动合并补丁层；对已安装的用户来说，一次发布只改变版本号。请把 `lib/index.js` 中的 `PLUGIN_VERSION` 与包版本一起更新——它会写入每条费用日志记录，便于追溯某条账目由哪个版本写入。修改任一 README 后，请重新记录 `README.i18n.yaml` 中的哈希：在三种语言重新一致之前，测试会失败。

## 测试

```sh
npm test
```

覆盖计价引擎（路由映射、模型 id 规范化、峰时窗口、缓存规则、未知模型）、日志记录与真实文件写入（在临时目录中执行）、插件激活路径（对桩宿主执行 `apply`：路由、六个工具、按回合触发落盘、释放）、并发落盘，以及以类 React 钩子存储渲染的客户端正式产物——断言三种语言定义相同的键、每条消息都能带参数渲染、语言选择遵循 配置 → harness 语言 → 浏览器语言。

有两套检查超出普通检出所能提供的范围：schema 检查通过 harness 自身的校验器运行工具 schema，打包产物则在 `npm pack` 之后测试。两者都需要 `@deepseek-ai/dsh-tools`，它只在 DSH profile 内可解析，因此在 profile 之外会明确标记为跳过，而不是静默通过。完整运行的命令：

```sh
dsh plugin --profile web add link:$PWD
npm pack && tar xzf dsh-chat-cost-*.tgz -C ~/.dsh/profiles/web/pack-check \
  && (cd ~/.dsh/profiles/web/pack-check/package && npm test)
```

## 预算规划

插件把费用日志变成约束：模型负责规划，插件负责计价、在金额上限内打包，并记录真实发生的花费。

| 工具 | 用途 |
| --- | --- |
| `cost_price` | 查询某供应商或模型的单价与缓存费率，让路由选择有据可依 |
| `cost_history` | 按已标记单元和模型给出实际花费与 P50/P90 分布——用于校准 |
| `cost_estimate` | 为一组工作单元计价，在预算内打包，并指出哪些放不下 |
| `cost_plan` | 写入或读取 `<project>/.dsh-cost/plan.json`（并生成 `plan.md`），以及设置金额预算 |
| `cost_mark` | 开启一个计划单元，让后续花费归到计划条目，而不是靠时间戳猜测 |
| `cost_scenarios` | 比较不同路由方案——`quality`、`connected`、`economy`、`balanced`——并指出本项目值得接入哪些模型 |

```
cost_plan   {action: write, budgetUsd: 20, units: [...]}   -> 生成 plan.json + plan.md，预留 20% 返工余量
cost_mark   {label: research}                              -> 此后花费计入 research
cost_history {}                                            -> research：预计 $2.10，实际 $1.84
cost_plan   {action: budget, budgetUsd: 25}                -> 组件随即显示 "≈ $0.42 / $25.00"
```

两条规则让估算可用而非装饰。估算给出**区间**：由声明 token 计算的结果是精确值，其余都带 P50 与 P90（默认按预期工作量的两倍），并标明数字来自 `declared`、`history` 还是 `bootstrap` 默认值。预算保留 **20% 的返工余量**，因为没有余量的计划是假的。没有价格的模型显示 `—`，绝不编造数字。

计划与预算文件属于“读—改—写”，因此每次修改都经过按项目目录划分的同一条队列：两次同时刷新的模型调用不会互相覆盖。只要计划输入未变，刷新会保留已保存的路由比较；输入变动时则带说明丢弃，因为按其他单元计价的比较是假的。`plan.md` 使用读数控件所报告的语言生成。

### 值得接入哪些模型

`cost_scenarios` 用四种路由为同一个计划计价：**quality**（每个单元都用首选路由）、**connected**（已列出的最便宜路由）、**economy**（整个目录中价格最低且满足要求的模型，可能需要接入你尚未使用的供应商）以及 **balanced**（标记为 `critical` 的单元用首选路由，其余用 economy）。每个方案都会给出预期与最坏总价、是否在预算内，以及需要哪些供应商。

随后给出的建议会指出主要成本来源、按单元排序切换可节省的金额，并列出三个最便宜的合格替代模型及其上下文大小与发布时间。合格性依据目录事实——推理、工具调用、视觉、上下文与输出上限——而不是质量评分，因为目录里没有评分。免费额度默认跳过，上下文明显小于首选路由的便宜模型会被标记为更窄，而不会悄悄推荐。

## 限制

- 推理 token 由供应商按输出计费，此处同样计入输出。
- 部分 Gemini 与 Grok 模型公布的长上下文档位价格尚未应用，当前使用基础档价格。
- 实时读数只统计日志尾部（`ledgerTailBytes`，默认 2 MiB）；更早的费用仍留在文件中，汇总会说明截断情况。
- 队列只串行化插件自身的写入。人在模型写入时手工编辑 `plan.json` 仍可能丢失该次编辑；该文件很小，用于查看而非并行编辑。

## 许可证

MIT
