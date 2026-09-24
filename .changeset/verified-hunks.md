---
"hunkdiff": minor
---

Add `!` to mark the selected hunk as verified and `V` to show or hide verified hunks. Verified hunks are stored by content hash in the file named by the new `verified_hunks_file` config key, so the marks survive rebases and can be synced between machines, and are hidden from the review stream by default.
