---
"hunkdiff": minor
---

Add the `whole_file` config key. Set it `true` to open every file already expanded to its whole content, as if `z` (`hunk.review.toggleFileContext`) had been pressed for each one; folding a file back by hand still works as usual. Bind `hunk.review.alignCurrentLineCenter` to `Z` by default, centering the current line in the viewport on demand.
