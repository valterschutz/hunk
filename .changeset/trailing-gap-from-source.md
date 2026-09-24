---
"hunkdiff": patch
---

Offer the unchanged tail after a file's last hunk as an expandable gap once the file's source text has loaded, so a git diff can be read through to the end of the file. The whole-file `z` toggle waits for that load and opens the tail too.
