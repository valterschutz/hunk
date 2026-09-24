---
"hunkdiff": patch
---

Fix expanded gap rows (whole-file review, or any manually expanded context) painting as part of
the neighboring hunk. Their rail now stays blank and their decision/selection styling no longer
bleeds in, so only a hunk's own lines read as that hunk.
