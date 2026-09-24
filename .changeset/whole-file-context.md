---
"hunkdiff": minor
---

Make `z` show the whole file: it expands every unchanged gap of the selected file at once and renders the result as one continuous listing, without `@@` hunk headers or gap toggles, and a second press folds the file back to its hunks. The old per-gap toggle stays available as `hunk.review.toggleHunkGap` for a custom keybinding and for clicks on a gap.
