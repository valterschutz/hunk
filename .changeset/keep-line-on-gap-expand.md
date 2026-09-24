---
"hunkdiff": patch
---

Keep the current line where it is when `z` expands unchanged context. Expanding the gap above the first hunk no longer throws the line marker to the top of the file, and the line stays on the same screen row while the revealed rows grow around it; collapsing from inside an expanded gap still returns to the line the reviewer started from.
