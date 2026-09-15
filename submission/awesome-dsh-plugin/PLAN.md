# Submission to awesome-dsh-plugin

Target: <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> (15.4k stars) — the curated list `dsh-market` reads from.

## Eligibility, checked against their contributing.md

| Requirement | Our state |
| --- | --- |
| `dsh.bundle` declared in `package.json` | yes — `dsh.bundle.patch: ./cordis.patch.yml` |
| `dsh-plugin` GitHub topic | yes — one of the 20 topics on the repo |
| Repository at least 1 day old | created `2026-09-12T18:14:28Z`, so eligible from **`2026-09-13T18:14:28Z`** |
| One file per plugin, `<owner>__<repo>.yml` | `igormel81__dsh-chat-cost.yml` sits beside this file |
| No hand-editing of the README | the README is generated from `data/plugins/*.yml` |

The category slug is `usage` — taken from three neighbouring entries in the same
section (`02Muller25/dsh-api-balance`, `133563825as-ai/dsh-api-dashboard`,
`1569126506-sudo/dsh-team-cost`), not guessed from the heading text.

The description is quoted because it contains `: `, which YAML would otherwise
read as a nested key — their guide calls this out explicitly.

## Commands

```sh
# 1) fork once
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false

# 2) commit the entry file into a new branch of the fork
gh api -X PUT repos/igormel81/awesome-dsh-plugin/contents/data/plugins/igormel81__dsh-chat-cost.yml \
  -f message="Add igormel81/dsh-chat-cost" \
  -f branch="add-dsh-chat-cost" \
  -f content="$(base64 -i submission/awesome-dsh-plugin/igormel81__dsh-chat-cost.yml)"

# 3) open the pull request
gh api -X POST repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls \
  -f title="Add igormel81/dsh-chat-cost" \
  -f head="igormel81:add-dsh-chat-cost" \
  -f base="main" \
  -f body="Adds one entry file, no generated README touched.

- repo: https://github.com/igormel81/dsh-chat-cost
- category: usage
- declares dsh.bundle, carries the dsh-plugin topic, repo older than one day."
```

## After it merges

- Add their badge to the README (they document it under "Badge"), in all three languages, and re-record `README.i18n.yaml`.
- `dsh-market` picks the entry up from the generated list, which makes the plugin a one-click install inside DSH.

## Notes from the neighbours

The `Usage & Billing` section already holds close work: `dsh-api-dashboard`
(per-session and per-subagent cost, DeepSeek peak/off-peak) and `dsh-team-cost`
(subagent metering, JSONL ledger, member budgets, over-budget enforcement). The
entry therefore leads with what is actually different here: a seven-provider
catalog with cache pricing, budget-aware plan packing, routing scenarios, and the
log written into the project folder — not with "cost tracking" in general.

## Other channels, checked on 2026-09-12

Crawl-based directories need no pull request: they scan the `dsh-plugin` topic
and the npm registry, so publishing to npm is the gate, not a form.

| Channel | How a plugin gets in | Our state |
| --- | --- | --- |
| [AdamPlatin123/dsh-plugin-radar](https://github.com/AdamPlatin123/dsh-plugin-radar) (1,464★, rescans every 6h) | "add the `dsh-plugin` topic → listed automatically within 8h"; a PR template exists for corrections | topic present; not listed yet |
| [DshMarketPlace/dshmarketplace](https://github.com/DshMarketPlace/dshmarketplace) (3,420 listings, public API) | crawl; `GET /api/v1/plugins?q=…` serves the catalogue | `q=chat-cost` → `total: 0` |
| [dsh-market](https://github.com/dsh-market/dsh-market) (3,529★) | reads the curated list above | follows the awesome-list merge |

Measured through the marketplace API on the same day, the closest neighbours in
the `usage` niche are small: `133563825as-ai/dsh-api-dashboard` is listed with 6
stars, and `1569126506-sudo/dsh-team-cost` does not appear at all (`total: 0`).
Nothing here changes the entry text, but it does mean the review question will be
"why another cost plugin" — which the description answers by leading with
interval pricing from the ledger, budget packing and routing scenarios.

Re-check both crawlers a day after `npm publish`; if the radar still has not
picked the repository up, open its PR template with the `dsh.bundle` evidence.

## Submitted

Both requests went out on 2026-09-14, from the account `igormel81`:

| Target | Result | State |
| --- | --- | --- |
| `awesome-dsh-plugin/awesome-dsh-plugin` | [pull #5078](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5078) — one file, `data/plugins/igormel81__dsh-chat-cost.yml`, +6 lines, mergeable | CI running; a maintainer reads the repository before merging |
| `Ericwong5021/deepseek-plugin-store` | [issue #285](https://github.com/Ericwong5021/deepseek-plugin-store/issues/285) — their form field by field | open, awaiting registry review |

The pull request was opened the way their guide prescribes: a fork, a branch, one
file, no generated README touched. The body states the manifest, the category, the
package and the repository age, and every claim in the entry is checkable in the
repository — which matters, because that list reads a description as a claim about
the code and returns entries that overstate.

Both texts live in `submission/promo/`; the entry itself in
`submission/awesome-dsh-plugin/`.

## Merged

Pull #5078 was merged on **2026-09-15T06:28:59Z**. The entry now lives upstream as
`data/plugins/igormel81__dsh-chat-cost.yml`, and the generated list places it in
**Usage & Billing** — the line is in `README.md` of the list, between
`ibka512/dsh-ibka-balance` and `izz-BLUE/dsh-deepseek-usage-dashboard`. The badge
they publish (`https://awesome-dsh-plugin.com/badge.svg`) is now in all three of
our READMEs, and `dsh-market`, which reads the generated list, follows on its own
schedule.

The store submission is still in review: their governance bot approved issue #285
labelled it `gov:approved`, verified the commit and opened pull #286 with a
generated registry entry.
