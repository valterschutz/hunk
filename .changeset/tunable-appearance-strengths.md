---
"hunkdiff": minor
---

Make the strengths Hunk derives from a theme's colors configurable: `unfocused_hunk_background_fade` and `unfocused_hunk_text_fade` set how far hunks outside the focused one recede, `inactive_rail_fade` the rail marker beside them, `cursor_line_strength` the current line, `copy_selection_strength` a copy selection, and `word_diff_emphasis` how loud intra-line changes are against the theme's own. Each is a whole percent whose default is the strength Hunk already painted, except the unfocused fades, which now default deeper.
