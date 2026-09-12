# dsh-chat-cost

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Web UI 显示每个对话的 token 费用：本对话、其子代理以及整棵会话树，价格来自内置的多供应商目录，并把只追加的 JSONL 费用日志写入你的项目目录。

[English](README.md) | 中文 | [Русский](README.ru.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blueviolet)](#安装)
[![providers](https://img.shields.io/badge/providers-7%20%C2%B7%20139%20models-informational)](#计价规则)

**关键词：** DeepSeek Harness 插件、dsh 插件、dsh-plugin、token 费用、单次对话费用、子代理费用、会话树费用、LLM 花费统计、token 用量、费用日志、JSONL、本地优先、DeepSeek V4.1 Flash、DeepSeek V4 Pro、OpenAI GPT-5、Anthropic Claude、Google Gemini、Kimi K3（Moonshot）、xAI Grok、Mistral、缓存读取与写入计价、峰谷计价、Cordis 插件。

## 状态

已完成：价格目录、计价引擎（峰谷时段、缓存读取与写入规则）、遍历会话树并为每个会话计价、写入 JSONL 费用日志的宿主端，以及英语、中文、俄语的客户端读数。

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
- **项目目录中的费用日志。** `<project>/.dsh-cost/cost.jsonl`，每个会话每次落盘一行 JSON，包含会话树位置、四项 token 统计、累计与增量费用以及价格来源。首次写入时会把 `.dsh-cost/` 加入项目的 `.gitignore`。
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

## 测试

```sh
npm test
```

覆盖计价引擎（路由映射、模型 id 规范化、峰时窗口、缓存规则、未知模型）、日志记录与真实文件写入（在临时目录中执行），以及以桩模块加载器加载的客户端正式产物——断言三种语言定义相同的键、每条消息都能带参数渲染、语言选择遵循 配置 → harness 语言 → 浏览器语言。

## 限制

- 推理 token 由供应商按输出计费，此处同样计入输出。
- 部分 Gemini 与 Grok 模型公布的长上下文档位价格尚未应用，当前使用基础档价格。

## 许可证

MIT
