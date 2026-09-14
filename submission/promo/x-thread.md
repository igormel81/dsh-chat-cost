# X / Twitter thread

Four posts. The first one has to stand alone, because most people will only see it.

**1/4**

```
DeepSeek Harness cost plugin: the append-only log is the source of truth.

Every flush prices only the tokens that arrived since the last record, at the
tariff in effect then. Recorded intervals are never re-priced, so a chat that
crossed a peak window keeps what it was actually billed.

npm: dsh-chat-cost
```

**2/4**

```
Every finished answer carries its own price in the transcript, folded from that
turn's own usage events.

Check it the way I did: in my session the 39 per-turn costs sum to the ledger's
last cumulative record exactly — $1.194087474, two independent code paths.

A chat that is not open is priced from the log and says so. A chat the log never
saw shows a dash, not a guess.
```

**3/4**

```
The catalog is bundled: models.dev snapshot, seven providers, 139 priced models,
DeepSeek on its own peak/off-peak table, cache read/write rates where the provider
publishes them.

The planning half: cost_plan packs a work plan under a money limit with 20% held
back for rework; cost_scenarios names the models worth connecting.
```

**4/4**

```
No account, no telemetry, no outbound request at runtime. Log is JSONL in your
project folder.

MIT, docs in English/Chinese/Russian, 140 tests.

github.com/igormel81/dsh-chat-cost

Limits, plainly: reasoning tokens count as output (that is how providers bill
them), and long-context tiers for some Gemini/Grok models are not applied yet.
```

**Notes**

- Post 1 must not be a link post: links in the first post cut reach. Put the link in post 4, or in a reply to post 1.
- Screenshots beat text here. Two images are enough: the composer readout, and one answer with its price under it. Attach them to post 1.
