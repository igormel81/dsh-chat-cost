# Pull request to awesome-dsh-plugin

**Title:** `Add igormel81/dsh-chat-cost`

**Body:**

```
Adds one entry file, no generated README touched.

- repo: https://github.com/igormel81/dsh-chat-cost
- entry: data/plugins/igormel81__dsh-chat-cost.yml
- category: usage
- package: dsh-chat-cost on npm, installable with `dsh plugin --profile web add dsh-chat-cost`
- manifest: package.json declares dsh.bundle.patch -> ./cordis.patch.yml
- repo age: created 2026-09-12T18:14:28Z

What it does, in one line: live token cost for a chat, its subagents and the whole
session tree, the price of each finished answer in the transcript, budget-aware
work plans packed under a money limit, and an append-only JSONL cost log written
into the project folder.

Everything the description claims is checkable in the repository: the seven
providers and 139 priced models are in data/prices.json, the six tools are in
lib/tools.js, the per-turn pricing is lib/turns.js, and the test suite is 140
tests (`npm test`). Limits are stated in the README too: a chat the log has never
seen and that is not open shows a dash rather than an estimate, and long-context
tier prices for some Gemini and Grok models are not applied yet.
```

**Commands** (one fork, one file, one PR):

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false

gh api -X PUT repos/igormel81/awesome-dsh-plugin/contents/data/plugins/igormel81__dsh-chat-cost.yml \
  -f message="Add igormel81/dsh-chat-cost" \
  -f branch="add-dsh-chat-cost" \
  -f content="$(base64 -i submission/awesome-dsh-plugin/igormel81__dsh-chat-cost.yml)"

gh api -X POST repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls \
  -f title="Add igormel81/dsh-chat-cost" \
  -f head="igormel81:add-dsh-chat-cost" \
  -f base="main" \
  -f body="$(cat submission/promo/awesome-pr-body.txt)"
```

The body above is stored as `submission/promo/awesome-pr-body.txt` for the last
command: quoting a multi-line body inline is how the submission gets mangled.

**After it merges:** add their badge to the three READMEs, re-record
`README.i18n.yaml`, and cut a patch release so the npm page shows it. `dsh-market`
reads the generated list, so it picks the plugin up on its own.
