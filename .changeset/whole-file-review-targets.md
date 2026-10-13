---
"hunkdiff": patch
---

Keep complete diff content visible in whole-file mode when filtering hunk states. Decided changes retain their additions, deletions, notes, and decision colors as context, while hunk/file navigation and individual decision actions target only eligible review units. Finishing a file advances to the next eligible file, wrapping when necessary, and reports completion only when no eligible units remain.
