# README screenshot — what to capture and where it goes

The catalogues show a summary and the README; a visitor decides in about ten seconds whether the plugin does anything real. Right now the strongest claim ("every answer carries its own price") has no picture. Two images fix that, and only the running GUI can produce them.

## Shot 1 — the readout and one priced answer

Frame both in one image if possible:

- the composer line: `≈ $1.19` (the chat total, next to the budget if one is set);
- one finished answer with `≈ $0.0xxx` underneath it.

Dark theme, window wide enough that neither number is clipped, no personal paths visible.

## Shot 2 — the tooltip

Hover the readout so the tooltip is open: it shows this chat, the subagents, the tree total, the token buckets, the models, the plan lines, the unclaimed-spend warning, and the log path. That single tooltip answers "what do I actually get" better than a paragraph.

## Where they go

1. Save as `docs/readout.png` and `docs/tooltip.png` in the repository.
2. In `README.md`, `README.ru.md` and `README.zh.md`, right after the badges and before `## Status`:

   ```md
   ![The readout in the composer, and the price under one answer](docs/readout.png)
   ```

   Captions stay short and factual — a claim in a caption is a claim that can be checked.
3. Re-record the hashes:

   ```sh
   for f in README.md README.zh.md README.ru.md; do echo "$f: $(git hash-object $f)"; done
   ```

   and paste them into `README.i18n.yaml`, or `npm test` fails on the parity record.
4. Cut a patch release so the npm page shows the same README the repository does.

## Why not a GIF

A GIF of a chat streaming looks impressive and proves nothing about the numbers. The two stills show the claim being made and the evidence behind it, which is what a reader is checking for. If a GIF is wanted later, make it the second thing after the numbers, not the first.
