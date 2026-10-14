---
"hunkdiff": minor
---

Review staged and unstaged changes together and stage them hunk by hunk. `hunk diff` now compares the working copy with `HEAD` (Git's empty tree before the first commit), and each hunk's rail shows whether it is staged (`stagedRailColor`), partly staged (`partlyStagedRailColor`), or unstaged (the plain rail). `Space` stages or unstages the selected hunk, staging a partly staged one in full; it no longer pages the review, and `Shift+Space` no longer pages back. Discarding reverts only a hunk's unstaged changes. Review decisions move off the rail to a dot before the hunk header, or on the hunk's first row when it has none, colored by the renamed `acceptedDotColor`, `rejectedDotColor`, and `fixedDotColor` theme keys. Adapters opt in through the new `staging` result field and `stageHunk` operation.
