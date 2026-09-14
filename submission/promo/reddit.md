# Reddit

Two subreddits fit, and one post can serve both if the title is plain. Post the repository link with the text below as the body.

**Title:**

```
I built a cost log for DeepSeek Harness chats that prices each answer separately, and never re-prices what it already recorded
```

**Body:**

```
Long agent sessions have a cost problem that a dashboard does not solve: the
number moves retroactively. If a chat crosses a peak-price window, or the tariff
changes, a re-computed total silently rewrites the past, and you cannot tell what
one answer cost you.

This is a plugin for DeepSeek Harness (dsh) that takes the opposite approach: the
append-only log is the source of truth.

- Each flush prices only the tokens that arrived since the previous record, at the
  tariff in effect at that moment. Recorded intervals keep the price they were
  billed at.
- Each finished answer gets its own price under it in the transcript, folded from
  that turn's usage events. In my own session the per-turn numbers sum to the
  ledger total exactly (39 turns, $1.194087474 — two independent code paths, same
  figure).
- A chat that is not open is priced from the log and says so; a chat the log has
  never seen shows a dash instead of an estimate.
- Prices: bundled models.dev snapshot, seven providers, 139 priced models,
  DeepSeek on its own peak/off-peak table, cache read and write rates where the
  provider publishes them.

There is a planning half too: six tools (cost_price, cost_history, cost_estimate,
cost_plan, cost_mark, cost_scenarios) let the agent price a route, mark a unit of
work so its spend is attributed rather than guessed, pack a plan under a money
limit with a 20% reserve, and compare routing scenarios — economy vs balanced vs
quality — that name the models worth connecting. Adequacy is decided from
catalog facts (reasoning, tools, vision, context), never from an invented quality
score.

Local only: no account, no telemetry, no outbound requests at runtime. The log is
JSONL in your project folder, and inside a git work tree the folder is added to
.gitignore on first write. npm, MIT, docs in English/Chinese/Russian.

Repo: https://github.com/igormel81/dsh-chat-cost
Install: dsh plugin --profile web add dsh-chat-cost

Known limits, since someone will ask: reasoning tokens count as output because
that is how providers bill them; long-context tier prices for some Gemini and Grok
models are not applied yet; a chat known only from the log has no turn boundaries
and shows no per-answer badges.

Happy to hear where the accounting model is wrong — that criticism is more useful
to me than stars.
```

**Notes**

- Attach the two stills from `docs/`: the composer readout, and one answer carrying `≈ $0.0441`. Both are in the README already, so the post and the repository agree.

- r/LocalLLaMA tolerates tool posts if they are specific and the author answers; r/DeepSeek and r/LLMDevs are smaller but closer to the topic. Post one, wait a day, then the other — the same text posted twice in an hour reads as spam.
- Do not paste the README. The three numbers that make the case are: interval pricing, per-turn sum equals the total, and the dash instead of a guess.
- If someone says "the provider already shows this", point at the interval argument rather than repeating features.
