---
"hunkdiff": minor
---

Review one hunk per edit rather than per Git `@@` hunk. Git folds edits whose context windows touch into a single hunk, so `]`, `[`, and `!` treated several nearby edits as one; each contiguous run of changed lines is now its own hunk, with the context between two edits shared out so every line stays on screen and no collapsed gap appears between them.
