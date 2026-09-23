---
"hunkdiff": patch
---

Keep review notes and the selected hunk on the text they were written beside when a reload changes a file: returning from `$EDITOR`, watch mode, and `hunk session reload` now relocate every note by its line's text instead of its line number, and drop the notes of a hunk that was staged, reverted, or rewritten away.
