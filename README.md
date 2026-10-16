# dsh-chat-cost

Live token cost for every chat in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) Web UI: the chat itself, its subagents and the whole session tree, priced from a bundled multi-provider catalog, with an append-only JSONL cost log written into your project folder.

English | [中文](README.zh.md) | [Русский](README.ru.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blueviolet)](#install)
[![npm](https://img.shields.io/npm/v/dsh-chat-cost.svg)](https://www.npmjs.com/package/dsh-chat-cost)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![providers](https://img.shields.io/badge/providers-7%20%C2%B7%20139%20models-informational)](#pricing-rules)

![The readout in the composer: one line under the harness stats, the session priced from the cost log](https://raw.githubusercontent.com/igormel81/dsh-chat-cost/main/docs/readout.png)

![The price of one answer, under that answer: this turn's own spend, not a share of the session total](https://raw.githubusercontent.com/igormel81/dsh-chat-cost/main/docs/answer.png)

**Keywords:** DeepSeek Harness plugin, dsh plugin, dsh-plugin, token cost, cost per chat, subagent cost, session tree cost, LLM spend tracking, token usage, cost log, JSONL, local-first, DeepSeek V4.1 Flash, DeepSeek V4 Pro, OpenAI GPT-5, Anthropic Claude, Google Gemini, Kimi K3 (Moonshot), xAI Grok, Mistral, cache read and cache write pricing, peak and off-peak pricing, Cordis plugin.

## Status

Working end to end, and verified against a running host rather than only in tests: DeepSeek's own CNY rate card, fetched once as the host starts, the pricing engine (peak tiers read at each turn's own time, cache read and write rules), the Host half that walks the session tree, prices every session per interval and appends the JSONL cost log, per-turn pricing folded from the session's own events, the six budget tools (`cost_price`, `cost_history`, `cost_estimate`, `cost_plan`, `cost_mark`, `cost_scenarios`), and the client readout in English, Chinese and Russian — in the composer for the chat, and under every finished answer for that answer.

Known limits, stated rather than hidden: the platform invoice can be higher than any session-based figure, because a web-search call runs its searches inside one request with a server-side tool and the pages it reads are billed to you without being part of the session's token usage — the readout counts those calls and names them rather than pretending to know their cost; a session that ended before the harness checkpointed its last turn (a host killed mid-turn) is priced from the newest checkpoint there is, so its final minutes may be missing; tokens read back from a checkpoint are charged at the tariff in force when they are read, and the record says `"basis":"durable"` so a catch-up is never mistaken for a watched interval; a child whose own log is gone is priced by the route it inherited from its tree, and `"modelSource":"inherited"` says so; a chat known only from the log has no turn boundaries, so it shows a total and no per-answer badges; long-context tier prices published for some Gemini and Grok models are not applied yet.

## Configuration

```yaml
- id: dsh-chat-cost
  name: dsh-chat-cost
  config:
    writeLog: true        # append the JSONL cost log into the project folder
    logDir: .dsh-cost      # directory name inside the project folder
    language: en          # en | zh | ru; omit to follow the harness locale, then the browser
    ledgerTailBytes: 2097152  # how much of the cost log is read back per summary (2 MiB)
```

## Features

- **DeepSeek prices, in yuan.** The table comes from DeepSeek's own Chinese rate card, so the figures are the ones the platform bills in rather than a converted approximation. It is fetched once as the host starts and cached beside the plugin, so a long-running host keeps one consistent table instead of changing rates mid-session.
- **Honest arithmetic.** Peak and off-peak tiers are read from the rate card using the time each turn's tokens were consumed, not the time the ledger happened to be read; a model outside the table — every provider except DeepSeek — reports that its price table is unknown and shows `—` rather than another vendor's number, and the total does not absorb a figure it cannot justify.
- **Breakdown by chat, subagents and session tree.** The hover tooltip separates this chat from its subagents and shows the tree total, the token buckets and the models involved.
- **Subagents are counted, including the ones that already finished.** The tree is the union of the query engine's trace, the live session store and session persistence, and usage for a session this host no longer runs comes from the harness's own durable projection checkpoint — the same counters the harness would restore it with. A released subagent is the normal case, not an edge one: a chat whose children were invisible is not a cheap chat, it is an unmeasured one.
- **Cost log in the project folder.** `<project>/.dsh-cost/cost.jsonl`, one JSON object per session per flush, with the tree position, four token buckets, cumulative and delta cost, and the pricing source. Inside a git work tree, `.dsh-cost/` is added to the project `.gitignore` on first write; a plain folder is left untouched — the log is welcome there, clutter is not.
- **Interval pricing.** The JSONL log is the base: every flush prices only the tokens that arrived since the previous record, at the tariff in effect at that moment, so a chat that crosses a DeepSeek peak boundary keeps the price it was really billed at instead of being re-priced retroactively.
- **Bounded, cached reads.** A summary reads only the tail of the log (`ledgerTailBytes`, 2 MiB by default) and reuses the cached read while the file's size and mtime are unchanged; when the tail starts mid-file the plugin reports `truncated` and `skippedBytes` instead of pretending to know the whole history.
- **Nothing is quietly unaccounted.** Spend that belongs to no plan unit is named in the tooltip (`¥1.230 is not attributed to any plan unit`) rather than folded into a total.
- **The price of each answer, under the answer.** Every finished turn gets its own cost in the transcript, priced from that turn's own usage events rather than sliced out of the session total, and refreshed the moment the turn closes. The composer readout shares one poll with those badges, so a finished answer updates both at once.
- **Every chat, open or not.** A chat that is not currently open has no live session, so the readout prices it — and its subagents — from the harness's durable checkpoint and from the cost log, and labels the number as recorded. A session neither of those knows stays `—` with the reason instead of disappearing. Opening it makes it live, prices it exactly, and writes the missing record.
- **Three languages.** English, Chinese and Russian, chosen from the plugin config, then the harness locale, then the browser language.

## Install

```sh
dsh plugin --profile web add dsh-chat-cost
```

The package is a DSH bundle: the profile reconciles its patch layer automatically (a dependency declaring `dsh.bundle` joins `dsh.profile.bundles`), so no patch editing is needed. Restart the host afterwards.

## Pricing rules

| Rule | Behaviour |
| --- | --- |
| DeepSeek | the official CNY rate card, fetched from DeepSeek's Chinese pricing page. Peak windows are Beijing time — 09:00-12:00 and 14:00-18:00 on weekdays — and double the price; the window is decided by when the tokens were consumed, taken from the turn's own events |
| Every other provider | no price at all: the readout says the price table is unknown rather than substituting DeepSeek's rate |
| Off-peak / cache read | the off-peak column of the card, used exactly as published; a cache read with no published price falls back to the input price, which is an upper bound |
| Tariff epochs | a record priced under another table is not additive with a figure from this one: its money is discarded and the session is re-priced whole under the current table. The epoch is the currency plus a hash of the rates, deliberately not the date they were fetched: re-reading an unchanged card must not invalidate a running session, so only a real price change starts a new epoch |
| Unknown model | resolves to no price; the readout says `—` and the tooltip names the model |
| Attribution | the log is the base: a recorded interval keeps the price it was billed at, only new tokens are priced |

The fetched table is cached at `data/rates-cny.json` inside the plugin, resolved from the plugin's own location rather than the working directory, and it records the date it was taken (`asOf`) so the age of a price is checkable rather than assumed. Each call to the vendor's page is parsed and validated, and a parse that does not look like the rate card is refused outright, leaving the previous table in place and marked stale — a half-read table is never used to bill anything. The readout names the table it used and its date.

### How the number is computed

The summary is built ledger-first: recorded deltas are summed from the log file, and only the tokens that arrived after the last record are priced at the current tariff. A chat that spans a peak boundary therefore shows what it really cost, not a retroactive double.

Each session in the tree says where its figure came from, so no source is passed off as another:

| `basis` | Read from | Priced at |
| --- | --- | --- |
| `live` | the running session's usage projection | the tariff in force now, minus what the log already recorded |
| `durable` | the harness's durable checkpoint of a session that ended | the tariff in force now, minus what the log already recorded |
| `log` | this plugin's cost log alone | what the log already recorded; no new tokens are priced |

And `modelSource` says how the route was learned: `session` from the session's own last request header, `inherited` from the tree it belongs to when the session is gone and only its counters survived.

### What the invoice adds that no session holds

Two kinds of provider call are billed and belong to no session's token usage:

| Call | Why it is invisible | What the readout does |
| --- | --- | --- |
| Web search | the DeepSeek-backed search provider sends one request with a server-side `web_search` tool; the pages the model reads are billed to you, and the response's usage is never written into the session log | counts the calls it can see in a live session and says the figure is a floor |
| A model call outside a turn | nothing in the session log describes it | nothing — the tooltip's totals are session totals and are named as such |

On a search-heavy day those calls can be the larger part of the bill. Measured against a platform export (24 Aug – 22 Sep 2026): on days with no searches the session-side figure and the platform's agreed to within a few cents (the export was denominated in USD at the time), and on days with hundreds the difference tracked the search count.

`npm run reconcile` is that measurement, and it is reproducible:

```sh
node scripts/reconcile.mjs --export ~/Downloads/usage_data_2026-08-24_2026-09-22.zip
```

It reads the platform's export and this host's session logs, folds the logs with the same replace-not-add rule the harness's own token projection uses, prices the difference at the platform's own per-day rates, and prints it next to that day's web-search count. Before it reports anything it checks every session's fold against the harness's durable counters and refuses to accuse the platform when its own arithmetic disagrees — the failure mode a reconciliation tool is most likely to have.

## Cost log format

```json
{"ts":"2026-10-11T13:49:56.019Z","plugin":"dsh-chat-cost@0.6.11","rootSessionId":"root-1","sessionId":"child-1","parentSessionId":"root-1","depth":1,"kind":"subagent","provider":"deepseek-official","model":"deepseek-flash","modelSource":"session","basis":"live","pricingSource":"table","tariff":"CNY:5968f96a","tier":"off-peak","tokens":{"uncachedInput":5000,"cacheRead":0,"cacheWrite":0,"output":1000},"totalTokens":6000,"deltaTokens":{"uncachedInput":1000,"cacheRead":0,"cacheWrite":0,"output":200},"deltaTotalTokens":1200,"cumulativeUsd":0.0058,"deltaUsd":0.0018}
```

A record with `"basis":"durable"` is a catch-up: the session was already over when its tokens were read back, so its delta is the part of its history this log had not seen yet.

## What it writes

Everything lives in the project folder, next to the work it describes.

| Path | Written by | What it holds |
| --- | --- | --- |
| `<project>/.dsh-cost/cost.jsonl` | every flush | one JSON object per session per interval: tree position, four token buckets, delta and cumulative cost, and the tariff it was billed at |
| `<project>/.dsh-cost/plan.json` | `cost_plan`, `cost_scenarios` | the priced work plan: units, chosen routes, what did not fit, the routing comparison |
| `<project>/.dsh-cost/budget.json` | `cost_plan {action: budget}` | the money limit and its note |
| `<project>/.dsh-cost/plan.md` | `cost_plan` | the same plan as a document for a human, in the language the readout reports |

The log is append-only: a record is never rewritten, which is what makes interval pricing possible. Remove the folder and the plugin starts from nothing — it keeps no state anywhere else.

## Privacy

No account, no telemetry, no server. One request is made as the host starts: a plain GET of DeepSeek's published Chinese pricing page, to refresh the rate table. Nothing is sent with it — no key, no identifiers, no session data — and it is skipped entirely when the cached table is recent. Apart from that the plugin talks only to the local host route, and the log is written into your own project folder. If the fetch fails the previous table is kept and reported as stale; nothing else changes.

## Releasing

```sh
npm test            # 153 tests; the schema checks need a DSH profile for the validator
npm run prices      # rebuild the bundled fallback table from the vendor page
npm version minor
npm publish --access public
for f in README.md README.zh.md README.ru.md; do echo "$f: $(git hash-object $f)"; done
```

### Prose check (optional, for maintainers)

The three READMEs are written by an assistant, so two failures are possible that no unit test sees: invisible characters and paste leftovers, and facts that change while a paragraph is rewritten. [`humanizer-ru`](https://github.com/Vladimir-Human/humanizer-ru) covers both, with published false-positive measurements, and `scripts/prose-check.mjs` wraps it:

```sh
uv tool install humanizer-ru
npm run prose            # artefacts (a hard gate), facts against the last release, soft style signs
npm run prose -- --strict  # also fail when the tool is absent, for CI
```

Class A artefacts fail the run; class B markers (invisible characters and exotic spaces, whose false-positive rate the tool measures as small but not zero) are printed to look at and never fail it. A lost term from `scripts/prose-terms.txt` (package name, log path, tool names, the two client slots) fails too; every other lost number or quotation is printed for a human to judge, because a version bump legitimately changes numbers. Soft style signs are printed and never fatal — the tool itself refuses to call them evidence, and a counter should not decide prose. It is not part of `npm test`: the suite must run for anyone who installs the package, and a Python tool is not a dependency of a Node plugin.

A release can also run through the `publish` workflow (Actions → publish → Run workflow): it tests, refuses a version that is already on the registry, and publishes with `--provenance` through npm trusted publishing, so no npm token is needed. The one-time trusted-publisher setup is written at the top of the workflow file.

The package is a DSH bundle: `dsh plugin --profile web add dsh-chat-cost` installs it and the profile reconciles the patch layer by itself, so a release changes nothing for a user who already has it except the version. Bump `PLUGIN_VERSION` in `lib/index.js` together with the package version — it stamps every cost-log record, which is how a ledger entry can be traced back to the release that wrote it. After editing any README, re-record the hashes in `README.i18n.yaml`: a test fails until the three languages agree again.

## Tests

```sh
npm test
```

Covers the pricing engine (route mapping, id canonicalization, peak windows, cache rules, unknown models), the per-turn fold (a streamed sample replaced by the final one, steps summed within a turn, the model in effect attributed to the turn that used it), the usage reader against every shape the harness hands over (flat, the projection's `totals` wrapper, a single step, the cache envelope), the context discipline of both halves (Cordis throws on any property a plugin did not inject, which took the host down once and the web shell once, so the source is checked mechanically), the log records and file writes against real files in a temporary directory, the plugin activation path (`apply` against a stub host: route, six tools, turn-driven flush, disposal), overlapping flushes, and the shipped client bundle rendered with a React-like hook store — asserting that all three languages define the same keys, that every message renders with its arguments, and that language resolution follows config → harness locale → browser.

Two suites go further than a plain checkout can: the schema checks run the tool schemas through the harness's own validator, and the boot suite loads the plugin on the real Cordis the harness uses (where reading config from the context instead of the loader argument throws). Both need packages that resolve only inside a DSH profile, so outside one they are reported as skipped rather than silently passing. A third check is not a suite at all: the published tarball is verified by running the same suite inside it, unpacked. For the full run:

```sh
dsh plugin --profile web add link:$PWD
npm pack && tar xzf dsh-chat-cost-*.tgz -C ~/.dsh/profiles/web/pack-check \
  && (cd ~/.dsh/profiles/web/pack-check/package && npm test)
```

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
cost_history {}                                            -> research: ¥1.84 actual against ¥2.10 expected
cost_plan   {action: budget, budgetUsd: 25}                -> the widget then shows "≈ ¥0.42 / ¥25.00"
```

Two rules make the estimates usable rather than decorative. Estimates are **ranges**: a unit priced from declared tokens is exact, anything else carries a P50 and a P90 (twice the expected work by default, and the tool says whether the number came from `declared` tokens, from `history`, or from a `bootstrap` default). And a budget keeps a **20% reserve** for rework, because a plan without a buffer is a lie. A model with no price resolves to `—`; nothing is invented.

Plan and budget files are read-modify-write, so every mutation goes through one queue per project folder: two model calls that refresh the plan at the same moment cannot lose each other's work. A refresh keeps the stored routing comparison while the plan inputs are unchanged and drops it with a note when they moved, because a comparison priced for other units is a lie. `plan.md` is generated in the language the readout reports.

### Which models are worth connecting

`cost_scenarios` prices the same plan under four routings: **quality** (the preferred route for every unit), **connected** (the cheapest route already listed), **economy** (the cheapest adequate route among those you listed) and **balanced** (preferred route for units marked `critical`, economy elsewhere). Each scenario reports expected and worst-case totals, whether it fits the budget, and the providers it needs. Because the rate table holds one provider, a scenario can only choose among the routes you declared — it never invents a cheaper one, and when nothing cheaper exists it says the four routings price identically rather than claiming a saving.

The recommendation names the cost drivers and ranks them by share. It does not claim a saving it cannot support: with no second provider in the table, `savingsUsd` is zero and the opportunities list is empty, because proposing a switch would mean inventing a price. Nothing here is a quality judgement — the table carries prices, not capability scores.

## Updating

The plugin is a profile dependency, so updating it is a pnpm operation in the profile directory — and one detail decides whether it works:

```sh
dsh plugin --profile web list                       # what is installed right now
dsh plugin --profile web add dsh-chat-cost@latest   # the normal path
dsh plugin --profile web update dsh-chat-cost       # within the declared range only
```

| Command | What actually happens |
| --- | --- |
| `add dsh-chat-cost@<version>` | installs exactly that version, immediately — the reliable path when a release is minutes old |
| `add dsh-chat-cost@latest` | resolves the `latest` tag; a version published minutes ago may be held back by pnpm's supply-chain policy, in which case the profile records an exception in `pnpm-workspace.yaml` or the previous version is installed |
| `update dsh-chat-cost` | moves only inside the range already declared in `package.json`; with an exact pin it does nothing |
| `add dsh-chat-cost` (no range) | resolves fresh and lands on `latest`; this is what re-installs the plugin if the profile lost it |

Restart the host afterwards: the profile's composition is assembled at boot, so a running host keeps the version it started with. To see which release is running without a terminal, hover the readout — the tooltip names it, and every cost-log record carries it in its `plugin` field (`"plugin":"dsh-chat-cost@0.6.9"`), which is how a ledger entry can be traced back to the release that wrote it.

## Uninstall and recovery

```sh
dsh plugin --profile web remove dsh-chat-cost
```

Restart the host afterwards. Removing the row stops all of it — the readout, the badges under answers, the tools, the log writes. What is already written (the cost log, the plan, the budget) is yours and stays where it is.

If a plugin keeps the host from starting, the boot names it (`plugin tree failed to load: …`), and the fix is the same command with `remove`: the composition is assembled at load, so a plugin cannot be unloaded from a host that is already broken.

## Compatibility

| Needs | Why |
| --- | --- |
| A DSH profile | the package is a bundle: `dsh.bundle.patch` points at `cordis.patch.yml`, and the profile reconciles it into `dsh.profile.bundles` |
| Node ≥ 20 | declared in `engines`; the plugin uses ESM and `AbortSignal.timeout` |
| The loader contract `apply(ctx, config)` | settings arrive as the second argument; reading them from `ctx` throws in this Cordis, and doing so once took the host down at boot |
| The web shell slots `conversation.composer.dock` and `conversation.chat.turnTail` | the composer readout and the per-answer badges; without them the Host half still prices, logs and answers its route |
| npm CLI ≥ 11.5.1 | only to release this package through npm trusted publishing, not to use it |

## Limitations

- Reasoning tokens are billed as output by the providers and are counted as output here.
- Long-context surcharges, where DeepSeek publishes them, are not applied yet; the base tier of a model is used.
- Chinese public holidays are not modelled: DeepSeek's peak windows exclude them, so figures read a little high on those days.
- A request that uses server-side web search is billed for the pages it reads, and that usage never reaches the session token counters: the readout counts those calls and is a floor, not the invoice.
- A chat that the log has never seen and that is not open shows `—`: the plugin prices what it can prove (the live session, or the log) and says so rather than estimating from a projection it cannot read.
- The live readout counts only the tail of the log (`ledgerTailBytes`, 2 MiB by default); older spend stays in the file and the summary reports the truncation.
- Per-answer badges exist for turns the Host can price. A chat taken from the log has a total and no turn boundaries, so it shows no badges rather than invented ones.
- The write queue serializes the plugin's own writes. A human editing `plan.json` at the moment the model writes it can still lose that edit; the file is small and meant to be reviewed, not co-edited.

## License

MIT
