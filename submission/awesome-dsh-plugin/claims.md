# Claims and where to check them

A reviewer of the awesome-list says plainly that a description is read as a claim
about the plugin and is checked against the code, and that overstating is the one
thing that gets an otherwise fine plugin sent back. This file exists so that check
takes minutes instead of an afternoon: every claim in
`igormel81__dsh-chat-cost.yml`, with the path that proves it.

| Claim | Where it holds |
| --- | --- |
| live token cost for a chat, its subagents and the whole session tree | `lib/index.js` — `collectTree`, `priceSession`, `summarizeTree`; the route `/api/plugins/dsh-chat-cost/summary` |
| a bundled models.dev snapshot | `data/prices.json` — `source`, `generatedAt`, `providers`; refreshed by `scripts/build-prices.mjs` |
| seven providers, 139 priced models | `data/prices.json` — providers `anthropic, deepseek, google, mistral, moonshotai, openai, xai`; 139 model entries |
| cache read and write rates wherever the provider publishes them | `lib/prices.js` — `providerEntry` copies `cacheRead`/`cacheWrite` when present; 80 models carry a read rate, 19 carry both |
| DeepSeek from its own peak and off-peak table | `lib/prices.js` — `DEEPSEEK_OFFICIAL`, `DEEPSEEK_PEAK_WINDOWS = [[1, 4], [6, 10]]`, `DEEPSEEK_PEAK_MULTIPLIER = 2`, `isPeakUtc` |
| every finished answer carries its own price in the transcript | `lib/turns.js` (the fold) + `lib/index.js` — `priceTurns`, `turns` in the summary; `lib/client.js` — the `conversation.chat.turnTail` registration |
| an answer's price is folded from its own usage events | `lib/turns.js` — `sampleOf`, the replace-not-add rule; `test/turns.test.mjs` |
| a chat that is not currently open is priced from the log | `lib/index.js` — `recordedBySession`, `recordedEntry`, `recorded: true` in the summary; `test/host.test.mjs` |
| spend is costed per interval; a recorded interval keeps its tariff | `lib/log.js` — `ledgerBase`; `lib/index.js` — `subtractUsage` before pricing; `test/pricing-tiers.test.mjs`, `test/host.test.mjs` |
| an append-only JSONL ledger in the project folder | `lib/log.js` — `appendCostLog` only appends; `LOG_DIR`/`LOG_FILE`; no code path rewrites or truncates it |
| budget-aware work plans packed against a money limit | `lib/budget.js` — `packPlan`; `lib/tools.js` — `cost_plan` |
| a 20% reserve for rework | `lib/budget.js` — `DEFAULT_BUFFER_RATIO = 0.2` |
| estimates are ranges with a stated origin | `lib/budget.js` — `percentile`, `DEFAULT_UNCERTAINTY`; `declared` / `history` / `bootstrap` in the estimate output |
| routing scenarios that show which models are worth connecting | `lib/scenarios.js` — `buildScenarios`, `adequateRoutes`, `recommend`; `lib/tools.js` — `cost_scenarios` |
| adequacy from catalog facts, never a quality score | `lib/scenarios.js` — `meetsRequirements` reads `caps` (reasoning, tools, vision, context, output); the note in the scenario output says exactly that |
| free tiers skipped unless asked for | `lib/scenarios.js` — `includeFree` defaults to `false`; `freeSkipped` is reported |
| a cheaper model with much smaller context is flagged narrower | `lib/scenarios.js` — `narrower` on each candidate |
| a generated plan document in English, Chinese or Russian | `lib/plan.js` — `PLAN_STRINGS`, `renderPlanMarkdown`; the language comes from the readout |
| a warning when spend belongs to no plan unit | `lib/log.js` — `UNLABELED_LABEL`; `lib/index.js` — `unlabeledUsd`; `lib/client.js` — the tooltip line |
| six tools | `lib/tools.js` — `cost_price`, `cost_history`, `cost_estimate`, `cost_plan`, `cost_mark`, `cost_scenarios` |
| the log directory is added to `.gitignore` inside a git work tree only | `lib/log.js` — `isGitWorkTree`, `ensureGitignore`; `test/logfile.test.mjs` |
| no account, no telemetry, no outbound request at runtime | `lib/` contains no `fetch` and no URL except the loopback parser for incoming requests; the only network command is `scripts/build-prices.mjs`, a maintainer task |
| English, Chinese and Russian documentation with a parity record | `README.md`, `README.zh.md`, `README.ru.md`, `README.i18n.yaml`; `test/docs.test.mjs` fails until the three agree |
| the readout names the release that produced it | `lib/index.js` — `version: PLUGIN_VERSION` in the summary, `plugin: dsh-chat-cost@<version>` in every record; `lib/client.js` — the tooltip line |
| tests | 142 of them, `npm test`; two suites report skips outside a DSH profile rather than passing silently |

## Limits stated in the same breath, not discovered later

- Reasoning tokens are billed as output by the providers and counted as output here.
- Long-context tier prices published for 22 catalog models are **not** applied; the base tier is used. `tiers` in `data/prices.json` is read by nothing in `lib/`.
- The live readout counts only the tail of the log (`ledgerTailBytes`, 2 MiB by default) and reports `truncated`/`skippedBytes` when it starts mid-file.
- A chat known only from the log has no turn boundaries, so it shows a total and no per-answer badges.
- A chat the log has never seen and that is not open shows `—` rather than an estimate.
- The write queue serializes the plugin's own writes; a human editing `plan.json` at the same moment can still lose that edit.
