---
"hunkdiff": patch
---

Fix the word-diff emphasis background disappearing once a line-highlighter extension (like a
mark/stage action) paints over the whole line — the highlight now blends from each span's own
background instead of one flat row color, so intraline diff emphasis stays visible under a mark.

Add optional `addedContentFg`/`removedContentFg` custom-theme keys so the word-diff span's text
color can be overridden too, alongside the existing `addedContentBg`/`removedContentBg`.
