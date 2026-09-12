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
```

## 功能

- **多供应商价格。** 内置 [models.dev](https://models.dev) 目录快照，覆盖七个供应商——DeepSeek、Moonshot、OpenAI、Anthropic、Google、xAI、Mistral——及其全部有价模型（当前 139 个）。
- **诚实的计算。** DeepSeek 使用其官方价格表并区分峰谷时段；缓存写入在有独立价格的供应商（Anthropic、OpenAI）按缓存写入价计费，否则按输入价计费；没有价格的模型显示 `—`，绝不编造数字。
- **按对话、子代理、会话树分级。** 悬停提示会分开显示本对话与其子代理，并给出会话树合计、token 明细与涉及的模型。
- **项目目录中的费用日志。** `<project>/.dsh-cost/cost.jsonl`，每个会话每次落盘一行 JSON，包含会话树位置、四项 token 统计、累计与增量费用以及价格来源。在 git 工作树中，首次写入时会把 `.dsh-cost/` 加入项目的 `.gitignore`；普通目录不做任何改动——日志可以写入，但不留下多余文件。
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

使用 `npm run prices`（七个精选供应商）或 `npm run prices:all`（目录中的全部供应商）刷新快照。

## 费用日志格式

```json
{"ts":"2026-09-12T20:00:00.000Z","plugin":"dsh-chat-cost","rootSessionId":"root-1","sessionId":"child-1","parentSessionId":"root-1","depth":1,"kind":"subagent","provider":"moonshot","model":"kimi-k3","pricingSource":"catalog","tier":"flat","tokens":{"uncachedInput":1000,"cacheRead":0,"cacheWrite":0,"output":200},"totalTokens":1200,"cumulativeUsd":0.006,"deltaUsd":0.002}
```

## 发布流程

```sh
npm test            # 83 项测试；schema 检查需要 DSH profile 提供校验器
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

覆盖计价引擎（路由映射、模型 id 规范化、峰时窗口、缓存规则、未知模型）、日志记录与真实文件写入（在临时目录中执行），以及以桩模块加载器加载的客户端正式产物——断言三种语言定义相同的键、每条消息都能带参数渲染、语言选择遵循 配置 → harness 语言 → 浏览器语言。

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

### 值得接入哪些模型

`cost_scenarios` 用四种路由为同一个计划计价：**quality**（每个单元都用首选路由）、**connected**（已列出的最便宜路由）、**economy**（整个目录中价格最低且满足要求的模型，可能需要接入你尚未使用的供应商）以及 **balanced**（标记为 `critical` 的单元用首选路由，其余用 economy）。每个方案都会给出预期与最坏总价、是否在预算内，以及需要哪些供应商。

随后给出的建议会指出主要成本来源、按单元排序切换可节省的金额，并列出三个最便宜的合格替代模型及其上下文大小与发布时间。合格性依据目录事实——推理、工具调用、视觉、上下文与输出上限——而不是质量评分，因为目录里没有评分。免费额度默认跳过，上下文明显小于首选路由的便宜模型会被标记为更窄，而不会悄悄推荐。

## 限制

- 推理 token 由供应商按输出计费，此处同样计入输出。
- 部分 Gemini 与 Grok 模型公布的长上下文档位价格尚未应用，当前使用基础档价格。

## 许可证

MIT
