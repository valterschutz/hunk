# Bulk approval prefix

Unbind the standalone agent-notes key before loading this extension:

```toml
[keybindings]
"hunk.view.toggleAgentNotes" = false
```

- `a f`: approve undecided hunks in the selected file immediately.
- `a a`: approve undecided hunks in the entire current review after confirmation.
- Escape or an unrecognized second key cancels the prefix.

Both actions include hidden undecided hunks and preserve accepted, rejected, and fixed decisions. They use the current review units (hunks or changed rows), require `review_file`, and never stage or change source files. Commit ranges cover the entire aggregate review. Content-identical units share a persisted decision, so the count reports unique identities.

The commands also appear in File and Help and can be bound directly as `hunk.review.approveFile` and `hunk.review.approveReview`. Prefix bindings belong to this extension; move agent notes to a toggle-prefix extension if desired.
