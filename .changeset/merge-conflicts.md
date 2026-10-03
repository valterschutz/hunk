---
"hunkdiff": minor
---

Review and resolve merge conflicts. A working-tree review lists every file Git left with conflict markers ahead of the rest, shows each conflict as one hunk with our side against theirs, and resolves the selected conflict in place: `<` keeps ours, `>` theirs, `|` both, and `B` the base when `diff3` markers recorded one. The sidebar flags conflicted files, their rail paints in `conflictRailColor`, and adapters report them through the new `conflictedFiles` result field.
