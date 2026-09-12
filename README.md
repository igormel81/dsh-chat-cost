# dsh-chat-cost

Live token cost for every chat in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) Web UI: the chat itself, its subagents and the whole session tree, priced from a bundled multi-provider catalog, with an append-only JSONL cost log written into your project folder.

English | [中文](README.zh.md) | [Русский](README.ru.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blueviolet)](#install)
[![providers](https://img.shields.io/badge/providers-7%20%C2%B7%20139%20models-informational)](#pricing-rules)

**Keywords:** DeepSeek Harness plugin, dsh plugin, dsh-plugin, token cost, cost per chat, subagent cost, session tree cost, LLM spend tracking, token usage, cost log, JSONL, local-first, DeepSeek V4.1 Flash, DeepSeek V4 Pro, OpenAI GPT-5, Anthropic Claude, Google Gemini, Kimi K3 (Moonshot), xAI Grok, Mistral, cache read and cache write pricing, peak and off-peak pricing, Cordis plugin.

## Status

Complete: the price catalog, the pricing engine (peak tiers, cache read and cache write rules), the Host half that walks the session tree, prices every session and appends the JSONL cost log, the budget-planning tools (`cost_price`, `cost_history`, `cost_estimate`, `cost_plan`, `cost_mark`), and the client readout in English, Chinese and Russian.

Known limits, stated rather than hidden: only live sessions expose provider usage, so a persisted-only subagent session is listed without a price; long-context tier prices published for some Gemini and Grok models are not applied yet.

## Configuration

```yaml
- id: dsh-chat-cost
  name: dsh-chat-cost
  config:
    writeLog: true        # append the JSONL cost log into the project folder
    logDir: .dsh-cost      # directory name inside the project folder
    language: en          # en | zh | ru; omit to follow the harness locale, then the browser
```

## Features

- **Multi-provider prices.** A bundled snapshot of the [models.dev](https://models.dev) catalog covers seven providers — DeepSeek, Moonshot, OpenAI, Anthropic, Google, xAI, Mistral — and every priced model of each (139 models today).
- **Honest arithmetic.** DeepSeek is priced from its own published table including peak and off-peak tiers; cache writes bill at each provider's own cache-write price where one exists (Anthropic, OpenAI) and at the input price otherwise; a model with no price shows `—` rather than an invented number.
- **Breakdown by chat, subagents and session tree.** The hover tooltip separates this chat from its subagents and shows the tree total, the token buckets and the models involved.
- **Cost log in the project folder.** `<project>/.dsh-cost/cost.jsonl`, one JSON object per session per flush, with the tree position, four token buckets, cumulative and delta cost, and the pricing source. `.dsh-cost/` is added to the project `.gitignore` on first write.
- **Three languages.** English, Chinese and Russian, chosen from the plugin config, then the harness locale, then the browser language.

## Install

```sh
dsh plugin --profile web add dsh-chat-cost
```

The package is a DSH bundle: the profile reconciles its patch layer automatically (a dependency declaring `dsh.bundle` joins `dsh.profile.bundles`), so no patch editing is needed. Restart the host afterwards.

## Pricing rules

| Rule | Behaviour |
| --- | --- |
| DeepSeek | official table, peak hours 01:00-04:00 and 06:00-10:00 UTC on weekdays double the price; cache writes have no separate fee, so they bill at the input price |
| Other providers | bundled models.dev snapshot, cache read and cache write prices used exactly as published |
| Unpublished cache read | falls back to the input price, which is an upper bound |
| Unknown model | resolves to no price; the readout says `—` and the tooltip names the model |

Refresh the snapshot with `npm run prices` (the seven curated providers) or `npm run prices:all` (every provider in the catalog).

## Cost log format

```json
{"ts":"2026-09-12T20:00:00.000Z","plugin":"dsh-chat-cost","rootSessionId":"root-1","sessionId":"child-1","parentSessionId":"root-1","depth":1,"kind":"subagent","provider":"moonshot","model":"kimi-k3","pricingSource":"catalog","tier":"flat","tokens":{"uncachedInput":1000,"cacheRead":0,"cacheWrite":0,"output":200},"totalTokens":1200,"cumulativeUsd":0.006,"deltaUsd":0.002}
```

## Releasing

```sh
npm test            # 83 tests; the schema checks need a DSH profile for the validator
npm run prices      # refresh the bundled catalog before a release
npm version minor
npm publish --access public
for f in README.md README.zh.md README.ru.md; do echo "$f: $(git hash-object $f)"; done
```

The package is a DSH bundle: `dsh plugin --profile web add dsh-chat-cost` installs it and the profile reconciles the patch layer by itself, so a release changes nothing for a user who already has it except the version. Bump `PLUGIN_VERSION` in `lib/index.js` together with the package version — it stamps every cost-log record, which is how a ledger entry can be traced back to the release that wrote it. After editing any README, re-record the hashes in `README.i18n.yaml`: a test fails until the three languages agree again.

## Tests

```sh
npm test
```

Covers the pricing engine (route mapping, id canonicalization, peak windows, cache rules, unknown models), the log records and file writes against real files in a temporary directory, and the shipped client bundle loaded with a stubbed module loader — asserting that all three languages define the same keys, that every message renders with its arguments, and that language resolution follows config → harness locale → browser.

## Budget planning

The plugin turns the cost log into a constraint: the model plans the work, the plugin prices it, packs it under a money limit and records what actually happened.

| Tool | Purpose |
| --- | --- |
| `cost_price` | prices and cache rates for a provider or model, so a route is chosen deliberately |
| `cost_history` | actual spend per marked unit and per model, with P50/P90 spread — the calibration source |
| `cost_estimate` | prices a list of units, packs them under a budget, and reports what would not fit |
| `cost_plan` | writes or reads `<project>/.dsh-cost/plan.json` (plus a generated `plan.md`), and sets the money budget |
| `cost_mark` | opens a plan unit, so later spend is attributed to the plan instead of guessed from timestamps |
| `cost_scenarios` | compares routings — `quality`, `connected`, `economy`, `balanced` — and names the models worth connecting for this project |

```
cost_plan   {action: write, budgetUsd: 20, units: [...]}   -> plan.json + plan.md, 20% held back for rework
cost_mark   {label: research}                              -> spend from here belongs to `research`
cost_history {}                                            -> research: $1.84 actual against $2.10 expected
cost_plan   {action: budget, budgetUsd: 25}                -> the widget then shows "≈ $0.42 / $25.00"
```

Two rules make the estimates usable rather than decorative. Estimates are **ranges**: a unit priced from declared tokens is exact, anything else carries a P50 and a P90 (twice the expected work by default, and the tool says whether the number came from `declared` tokens, from `history`, or from a `bootstrap` default). And a budget keeps a **20% reserve** for rework, because a plan without a buffer is a lie. A model with no price resolves to `—`; nothing is invented.

### Which models are worth connecting

`cost_scenarios` prices the same plan under four routings: **quality** (the preferred route for every unit), **connected** (the cheapest route already listed), **economy** (the cheapest adequate model in the whole catalog — which may mean connecting a provider you do not use yet) and **balanced** (preferred route for units marked `critical`, economy elsewhere). Each scenario reports expected and worst-case totals, whether it fits the budget, and the providers it needs.

The recommendation names the cost drivers, ranks what switching would save per unit, and lists the three cheapest adequate alternatives with their context size and release date. Adequacy uses catalog facts — reasoning, tool calling, vision, context and output limits — and never a quality score, because the catalog has none. Free tiers are skipped unless asked for, and a cheaper model whose context is much smaller than your preferred route is flagged as narrower rather than quietly recommended.

## Limitations

- Reasoning tokens are billed as output by the providers and are counted as output here.
- Long-context tier prices published for some Gemini and Grok models are not applied yet; the base tier is used.

## License

MIT
