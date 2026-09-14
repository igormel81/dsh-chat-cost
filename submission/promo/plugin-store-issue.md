# Issue in Ericwong5021/deepseek-plugin-store

Their form asks for one plugin per issue and root `package.json:dsh.bundle` evidence. Field by field, ready to paste:

| Field | Value |
| --- | --- |
| Title | `[Add Plugin] dsh-chat-cost` |
| Plugin name | `igormel81/dsh-chat-cost` |
| Repository URL | `https://github.com/igormel81/dsh-chat-cost` |
| Install identifier | `dsh-chat-cost` |
| Category | `Integrations & Communication / Notifications & Monitoring` |
| Maintainer identity | `igormel81` |

**Category evidence** (they ask for README, manifest, exports or source paths):

```
package.json declares "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
README.md -> "Configuration", "Cost log format", "What it writes" (the four files it leaves in a project folder)
lib/index.js -> the web route /api/plugins/dsh-chat-cost/summary and the ledger flush
lib/tools.js -> six model-facing tools: cost_price, cost_history, cost_estimate, cost_plan, cost_mark, cost_scenarios
lib/turns.js -> per-turn pricing folded from the session's own events
test/ -> 140 tests, `npm test`
```

**Summary** (their field is called `Summary`):

```
Live token cost for every chat in the DeepSeek Harness Web UI: the chat itself, its subagents and the whole session tree. The widget in the composer shows the chat total, and every finished answer carries its own price underneath it. A chat that is not currently open is priced from the cost log instead of showing nothing. Prices come from a bundled models.dev snapshot of seven providers and 139 priced models, with DeepSeek on its own peak and off-peak table; cache read and cache write rates are used wherever the provider publishes them.

Beyond the readout, the plugin turns the log into a constraint: six tools let the model price a route, record what a unit of work actually cost, pack a work plan under a money limit with a 20% reserve for rework, and compare routing scenarios that name the models worth connecting. Spend that belongs to no plan unit is reported rather than folded into a total.

The cost log is append-only JSONL in the project folder (.dsh-cost/cost.jsonl), one record per session per interval, with the tree position, four token buckets, the delta and cumulative cost, and the tariff it was billed at. Cost is computed per interval, so work that ran during a DeepSeek peak window keeps the price it was really billed at. No account, no telemetry, no outbound request at runtime.

Install: dsh plugin --profile web add dsh-chat-cost (npm, MIT, provenance-signed releases). Docs in English, Chinese and Russian.
```

**Declaration checkboxes** are all true for this repository: the submitter maintains it, the repository is public, the root `package.json` declares `dsh.bundle`, and the request contains exactly one plugin.

**How to submit.** Their form is a GitHub issue *form*: the reliable way is
<https://github.com/Ericwong5021/deepseek-plugin-store/issues/new?template=plugin-submission.yml>
with the values pasted field by field. The same text is also stored as
`submission/promo/plugin-store-body.txt` with their exact headings, so a
non-interactive submission keeps the shape their automation expects:

```sh
gh issue create --repo Ericwong5021/deepseek-plugin-store \
  --title "[Add Plugin] dsh-chat-cost" \
  --body-file submission/promo/plugin-store-body.txt
```
