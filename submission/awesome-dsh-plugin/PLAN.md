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
