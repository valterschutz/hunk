---
"hunkdiff": minor
---

Replace the single verified mark with per-hunk decisions: `+` accepts the selected hunk, `-` rejects it, and `=` marks a rejected hunk addressed; `V` shows or hides decided hunks, and `show_decided_hunks` starts with them shown. Decisions live in the JSON Lines file named by the new `review_file` config key (replacing `verified_hunks_file`), keyed by hunk content so they survive rebases and sync between machines, and the rail paints accepted, rejected, and addressed hunks in `acceptedRailColor`, `rejectedRailColor`, and `addressedRailColor` (replacing `verifiedRailColor`). Deciding every hunk of a `hunk show` review derives the commit's status into a `commit-status` file beside the review file: `verified` while a rejection is open, `addressed` once none is.
