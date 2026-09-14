# Show HN

**Title:**

```
Show HN: Token cost for every chat in DeepSeek Harness, priced per interval from a log
```

(Under 80 characters, no hype, no "best". Alternative if that reads long:
`Show HN: A cost ledger for DeepSeek Harness chats, priced per interval`.)

**Body** — post this as the first comment, not as the submission text:

```
I run a lot of long agent sessions and kept hitting the same wall: the number a
cost dashboard shows you is usually a re-computation, not a bill. If a chat
crossed a peak-price window, the total quietly changed retroactively, and there
was no way to tell what a single answer actually cost.

So this is a plugin for DeepSeek Harness (dsh) that treats the cost log as the
source of truth:

- Every flush prices only the tokens that arrived since the previous record, at
  the tariff in effect at that moment. A recorded interval is never re-priced.
- Every finished answer shows its own price in the transcript, folded from that
  turn's own usage events (a streamed sample is replaced by the final one for the
  same step, not added to it), so the numbers add up to the session total instead
  of being sliced out of it. On my own session: 39 turns, and the sum of the
  per-turn costs equals the ledger's last cumulative record exactly.
- A chat that is not open has no live session, so it is priced from the log, with
  the tooltip saying so. A chat the log has never seen shows a dash rather than an
  estimate — I would rather show nothing than a plausible wrong number.
- Prices come from a bundled models.dev snapshot (seven providers, 139 priced
  models), with DeepSeek on its own peak/off-peak table and cache read/write rates
  used wherever a provider publishes them.

The other half of it is planning: six tools let the model price a route, record
what a unit of work really cost, pack a plan under a money limit with a 20%
reserve for rework, and compare routing scenarios that name the models worth
connecting. Spend that belongs to no plan unit is called out, not folded into a
total.

Everything is local: no account, no telemetry, no outbound request at runtime.
The log is append-only JSONL inside your project folder.

Honest limits: reasoning tokens are counted as output because that is how
providers bill them; long-context tier prices published for some Gemini and Grok
models are not applied yet; and a chat known only from the log has no turn
boundaries, so it shows a total and no per-answer badges.

npm: dsh-chat-cost (MIT). Docs in English, Chinese and Russian. Happy to answer
questions about the accounting model — that part is the interesting bit, and I
expect the interesting criticism to be about it too.
```

**Notes for whoever posts it**

- HN punishes marketing language. The text above makes claims only where the repository can be checked, and states the limits in the same post; that is deliberate.
- The submission URL should be the repository, not npm: readers want the README and the source.
- Answer the first technical question within minutes, or the thread dies. The most likely one is "why not just use the provider's dashboard" — the answer is the interval argument above.
- Do not post on a Friday evening or a weekend morning; a Tuesday to Thursday, 13:00–15:00 UTC window is what usually works.
