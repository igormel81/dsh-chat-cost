# dsh-chat-cost

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Web UI 显示每个对话的 token 费用：本对话、其子代理以及整棵会话树，价格来自内置的多供应商目录，并把只追加的 JSONL 费用日志写入你的项目目录。

[English](README.md) | 中文 | [Русский](README.ru.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blueviolet)](#安装)
[![npm](https://img.shields.io/npm/v/dsh-chat-cost.svg)](https://www.npmjs.com/package/dsh-chat-cost)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![providers](https://img.shields.io/badge/providers-7%20%C2%B7%20139%20models-informational)](#计价规则)

![The readout in the composer: one line under the harness stats, the session priced from the cost log](https://raw.githubusercontent.com/igormel81/dsh-chat-cost/main/docs/readout.png)

![The price of one answer, under that answer: this turn's own spend, not a share of the session total](https://raw.githubusercontent.com/igormel81/dsh-chat-cost/main/docs/answer.png)

**关键词：** DeepSeek Harness 插件、dsh 插件、dsh-plugin、token 费用、单次对话费用、子代理费用、会话树费用、LLM 花费统计、token 用量、费用日志、JSONL、本地优先、DeepSeek V4.1 Flash、DeepSeek V4 Pro、OpenAI GPT-5、Anthropic Claude、Google Gemini、Kimi K3（Moonshot）、xAI Grok、Mistral、缓存读取与写入计价、峰谷计价、Cordis 插件。

## 状态

端到端可用，并且是在真实宿主上验证过的，而不只是测试里：内置的七家供应商目录、计价引擎（峰谷时段、缓存读取与写入规则）、遍历会话树并按区间为每个会话计价并写入 JSONL 费用日志的宿主端、从会话自身事件折算的按轮计价、六个预算工具（`cost_price`、`cost_history`、`cost_estimate`、`cost_plan`、`cost_mark`、`cost_scenarios`），以及英语、中文、俄语的客户端读数——输入区显示整个对话，每个完成的回答下面显示该回答自身的费用。

已知限制（明示而非隐藏）：平台账单可能高于任何基于会话的数字，因为网络搜索调用是在一个请求内用服务端工具完成搜索，它读取的网页会计费到你头上，却不进入会话的 token 用量 —— 读数会统计这类调用并点名，而不是假装知道它们的费用；在 harness 尚未把最后一轮写入检查点之前就结束的会话（宿主在轮次中途被杀），只能按现存最新的检查点计价，因此最后几分钟可能缺失；从检查点读回的历史 token 按读取时生效的价位计费，记录中写着 `"basis":"durable"`，因此补记不会被误认为实测区间；自身日志已不在的子会话按从会话树继承的模型计价，`"modelSource":"inherited"` 会说明这一点；仅从日志得知的对话没有轮次边界，因此它显示总额而不显示每个回答的费用；部分 Gemini 与 Grok 模型公布的长上下文档位价格尚未应用。

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
- **子代理会被计入，包括已经结束的。** 会话树是三个来源的并集：查询引擎的追踪、活动会话存储，以及持久化会话存储；而宿主已不再运行的会话，其用量取自 harness 自己的持久化投影检查点——也就是它恢复该会话时会用的同一组计数。已结束的子代理是常态而非边角情形：看不见子节点的对话不是便宜的对话，而是没被测过的对话。
- **项目目录中的费用日志。** `<project>/.dsh-cost/cost.jsonl`，每个会话每次落盘一行 JSON，包含会话树位置、四项 token 统计、累计与增量费用以及价格来源。在 git 工作树中，首次写入时会把 `.dsh-cost/` 加入项目的 `.gitignore`；普通目录不做任何改动——日志可以写入，但不留下多余文件。
- **按区间计价。** 以 JSONL 日志为准：每次落盘只对上次记录之后新增的 token 按当时生效的价格计费。跨过 DeepSeek 峰时边界的对话保留实际计费价格，不会被追溯重算。
- **有界读取与缓存。** 汇总只读取日志尾部（`ledgerTailBytes`，默认 2 MiB），并在文件大小与修改时间未变时复用缓存；若尾部从文件中间开始，插件会报告 `truncated` 与 `skippedBytes`，而不是假装掌握全部历史。
- **不会悄悄漏账。** 未归入任何计划单元的费用会在提示中点名（`$1.230 未归入任何计划单元`），而不是混进合计。
- **每个回答下面都有它自己的费用。** 已完成的每一轮都会在对话中显示费用：它按该轮自身的使用事件计价，而不是从会话总额里切一块，并在该轮结束时立即刷新。输入区的读数与这些标记共用同一次轮询，因此回答完成时两者会同时更新。
- **每个对话都有读数，无论是否打开。** 未打开的对话没有活动会话，因此读数按 harness 的持久化记录与费用日志为它本身及其子代理计价，并标注为“日志记录”。两个来源都不认识的会话显示 `—` 并说明原因，而不是整行消失。打开它后会成为活动会话，被精确计价，并补写缺失的记录。
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

`data/prices.json` 记录了快照的来源（`source`）与生成时间（`generatedAt`），因此价格的新旧可以被核查，而不是靠猜。刷新方式：`npm run prices`（七个精选供应商）或 `npm run prices:all`（目录中的全部供应商）。

### 数字如何得出

汇总以日志为基础：已记录的增量直接由文件求和，只有最后一条记录之后的 token 才按当前价格计费。因此跨峰时边界的对话显示的是实际花费，而不是被追溯翻倍的结果。

会话树中每个会话都会说明自己的数字来自哪里，以免一个来源被当成另一个：

| `basis` | 读取自 | 计价方式 |
| --- | --- | --- |
| `live` | 正在运行的会话的用量投影 | 按当前生效价位，减去日志已记录的部分 |
| `durable` | harness 对已结束会话的持久化记录 | 按当前生效价位，减去日志已记录的部分 |
| `log` | 仅本插件的费用日志 | 按日志已记录的数字；不再对新增 token 计价 |

`modelSource` 说明模型是如何得知的：`session` 来自该会话自己最后一次请求头，`inherited` 来自会话树——当会话已不存在、只剩计数时如此。

### 平台账单里有什么是任何会话都没有的

有两类供应商调用会计费，但不属于任何会话的 token 用量：

| 调用 | 为何不可见 | 读数的做法 |
| --- | --- | --- |
| 网络搜索 | DeepSeek 搜索提供方用服务端 `web_search` 工具在一个请求内完成搜索；模型读到的网页计费到你头上，而响应中的用量从不写入会话日志 | 统计活动会话中可见的调用数，并说明该数字是下限 |
| 轮次之外的模型调用 | 会话日志里没有任何描述 | 不做处理 —— 提示中的合计是会话合计，并且如此标明 |

在搜索频繁的日子里，这类调用可能占账单的大头。对照平台导出（2026-08-24 至 09-22）核算：没有搜索的日子，会话侧数字与平台数字相差在 $0.05 以内；有数百次搜索的日子，差额随搜索次数变化，约为每次搜索 $0.002–0.006。

## 费用日志格式

```json
{"ts":"2026-09-12T20:00:00.000Z","plugin":"dsh-chat-cost@0.6.9","rootSessionId":"root-1","sessionId":"child-1","parentSessionId":"root-1","depth":1,"kind":"subagent","provider":"moonshot","model":"kimi-k3","modelSource":"session","basis":"live","pricingSource":"catalog","tier":"flat","tokens":{"uncachedInput":5000,"cacheRead":0,"cacheWrite":0,"output":1000},"totalTokens":6000,"deltaTokens":{"uncachedInput":1000,"cacheRead":0,"cacheWrite":0,"output":200},"deltaTotalTokens":1200,"cumulativeUsd":0.014,"deltaUsd":0.002}
```

带有 `"basis":"durable"` 的记录属于补记：读回这些 token 时会话已经结束，因此它的增量是本日志此前未见过的那部分历史。

## 写入了什么

一切都放在项目目录里，与被描述的工作放在一起。

| 路径 | 由谁写入 | 内容 |
| --- | --- | --- |
| `<project>/.dsh-cost/cost.jsonl` | 每次落盘 | 每个会话每个区间一条 JSON：会话树位置、四项 token 统计、增量与累计费用，以及当时的费率 |
| `<project>/.dsh-cost/plan.json` | `cost_plan`、`cost_scenarios` | 已计价的工作计划：单元、选定的路由、放不下的部分、路由比较 |
| `<project>/.dsh-cost/budget.json` | `cost_plan {action: budget}` | 金额上限与备注 |
| `<project>/.dsh-cost/plan.md` | `cost_plan` | 同一份计划的人类可读文档，使用读数控件所报告的语言 |

日志是只追加的：记录从不被改写——这正是按区间计价得以成立的原因。删除该目录，插件就从零开始：它在别处不保存任何状态。

## 隐私

没有账号、没有遥测、没有服务器。运行时插件完全不发出站请求：价格来自内置快照，控件只访问本机宿主的接口，日志写入你自己的项目目录。唯一联网的命令是 `npm run prices`，它从 models.dev 重建目录，面向维护者在发布前运行，而不是给用户使用。

## 发布流程

```sh
npm test            # 148 项测试；schema 检查需要 DSH profile 提供校验器
npm run prices      # 发布前刷新内置价格目录
npm version minor
npm publish --access public
for f in README.md README.zh.md README.ru.md; do echo "$f: $(git hash-object $f)"; done
```

### 文本检查（可选，面向维护者） 

三份 README 由助手撰写，因此存在两类单元测试看不到的问题：不可见字符与粘贴残留，以及改写段落时被悄悄改动的**事实**。[`humanizer-ru`](https://github.com/Vladimir-Human/humanizer-ru) 两者都能覆盖，且公布了误报率数据，`scripts/prose-check.mjs` 则把它包了起来：

```sh
uv tool install humanizer-ru
npm run prose            # 残留字符（硬性门槛）、与上一次发布的事实比对、软性风格信号
npm run prose -- --strict  # 工具缺失时也失败，用于 CI
```

A 类残留会让检查失败；B 类标记（不可见字符与特殊空格——按工具公布的测量，其误报率很小但不为零）只打印出来供查看，永不导致失败。`scripts/prose-terms.txt` 中的术语（包名、日志路径、工具名、两个客户端插槽）丢失同样失败；其余丢失的数字与引文只打印出来供人判断，因为版本升级本来就会改变数字。软性风格信号只打印、永不致命——工具本身拒绝把它们当作证据，计数器也不该替文章做决定。它不属于 `npm test`：测试套件必须能在任何安装本包的环境运行，而 Python 工具不是 Node 插件的依赖。

发布也可以通过 `publish` workflow 完成（Actions → publish → Run workflow）：它会运行测试、拒绝发布已存在于注册表中的版本，并通过 npm 可信发布以 `--provenance` 上传，无需 npm 令牌。一次性配置可信发布者的步骤写在 workflow 文件开头。

本包是 DSH bundle：`dsh plugin --profile web add dsh-chat-cost` 即可安装，profile 会自动合并补丁层；对已安装的用户来说，一次发布只改变版本号。请把 `lib/index.js` 中的 `PLUGIN_VERSION` 与包版本一起更新——它会写入每条费用日志记录，便于追溯某条账目由哪个版本写入。修改任一 README 后，请重新记录 `README.i18n.yaml` 中的哈希：在三种语言重新一致之前，测试会失败。

## 测试

```sh
npm test
```

覆盖计价引擎（路由映射、模型 id 规范化、峰时窗口、缓存规则、未知模型）、按轮的折算（流式样本被最终样本替换、同一轮的各步相加、按实际使用把模型归属到相应轮次）、harness 可能给出的各种 token 统计形态（扁平结构、投影的 `totals` 包装、单步值、缓存信封）、两半的上下文纪律（Cordis 对插件未在 inject 中声明的任何属性都会抛错——它曾让宿主崩溃一次、让 Web 外壳崩溃一次，因此源码会被机械检查）、日志记录与真实文件写入（在临时目录中执行）、插件激活路径（对桩宿主执行 `apply`：路由、六个工具、按回合触发落盘、释放）、并发落盘，以及以类 React 钩子存储渲染的客户端正式产物——断言三种语言定义相同的键、每条消息都能带参数渲染、语言选择遵循 配置 → harness 语言 → 浏览器语言。

有两项检查超出普通检出所能提供的范围：schema 检查通过 harness 自身的校验器运行工具 schema；启动套件把插件加载到 harness 实际使用的 Cordis 上（在那里从上下文而非加载器参数读取配置会抛错）。两者都需要只在 DSH profile 内可解析的包，因此在 profile 之外会明确标记为跳过，而不是静默通过。第三项检查根本不是测试套件：发布用的 tarball 通过在其中运行同一套测试来验证。完整运行的命令：

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

## 更新

插件是 profile 的依赖，因此更新就是在 profile 目录里执行 pnpm 操作，而有一个细节决定它是否生效：

```sh
dsh plugin --profile web list                       # 当前安装的是什么
dsh plugin --profile web add dsh-chat-cost@latest   # 常规方式
dsh plugin --profile web update dsh-chat-cost       # 只在已声明的版本范围内更新
```

| 命令 | 实际发生的事 |
| --- | --- |
| `add dsh-chat-cost@<版本>` | 精确安装该版本，立即生效——刚发布几分钟时这是可靠方式 |
| `add dsh-chat-cost@latest` | 解析 `latest` 标签；几分钟前发布的版本可能被 pnpm 的供应链策略拦下，此时 profile 会在 `pnpm-workspace.yaml` 中记录例外，或者安装上一个版本 |
| `update dsh-chat-cost` | 只在 `package.json` 已声明的范围内前移；若为精确锁定则什么都不做 |
| `add dsh-chat-cost`（不带范围） | 重新解析并落到 `latest`；profile 丢失插件时也是这样装回来 |

之后请重启宿主：profile 的组合是在启动时装配的，运行中的宿主会一直停留在启动时的版本。不打开终端也能知道运行的是哪个版本——悬停读数控件即可，提示中会写出该版本；而每条费用日志记录都在 `plugin` 字段里带着它（`"plugin":"dsh-chat-cost@0.6.9"`），因此一条账目可以追溯到写入它的那个发布。

## 卸载与恢复

```sh
dsh plugin --profile web remove dsh-chat-cost
```

之后重启宿主。移除该行会停掉全部功能：输入区读数、回答下方的费用、工具、日志写入。已经写入的内容（费用日志、计划、预算）属于你，原地保留。

如果某个插件导致宿主无法启动，启动日志会点名它（`plugin tree failed to load: …`），处理办法就是同一条命令加 `remove`：组合是在加载时装配的，因此已经损坏的宿主无法卸载插件。

## 兼容性

| 需要 | 原因 |
| --- | --- |
| 一个 DSH profile | 本包是 bundle：`dsh.bundle.patch` 指向 `cordis.patch.yml`，profile 会自动把它并入 `dsh.profile.bundles` |
| Node ≥ 20 | 在 `engines` 中声明；插件使用 ESM 与 `AbortSignal.timeout` |
| 加载器契约 `apply(ctx, config)` | 配置作为第二个参数传入；在这个 Cordis 中从 `ctx` 读取会抛错，曾经因此让宿主在启动时崩溃 |
| Web 外壳的插槽 `conversation.composer.dock` 与 `conversation.chat.turnTail` | 输入区读数与回答下方的费用；没有它们时宿主端仍会计价、写日志并响应自己的接口 |
| npm CLI ≥ 11.5.1 | 仅用于通过 npm 可信发布来发布本包，而不是使用它 |

## 限制

- 推理 token 由供应商按输出计费，此处同样计入输出。
- 部分 Gemini 与 Grok 模型公布的长上下文档位价格尚未应用，当前使用基础档价格。
- 日志中从未出现且未打开的对话显示 `—`：插件只计入可证实的部分（活动会话或日志），并明确说明，而不是根据它读不到的投影去估算。
- 实时读数只统计日志尾部（`ledgerTailBytes`，默认 2 MiB）；更早的费用仍留在文件中，汇总会说明截断情况。
- 回答下方的费用只针对宿主能够计价的轮次。仅从日志取数的对话有总额但没有轮次边界，因此不显示这些费用，而不是编造。
- 队列只串行化插件自身的写入。人在模型写入时手工编辑 `plan.json` 仍可能丢失该次编辑；该文件很小，用于查看而非并行编辑。

## 许可证

MIT
