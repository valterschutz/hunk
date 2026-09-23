---
"hunkdiff": patch
---

Keep a live session registered when a review note exceeds the daemon's 4096-byte wire limit: the window now clips note text before publishing a snapshot, the daemon drops a snapshot it cannot parse instead of closing the session, and a launched daemon writes its output to `hunk-mcp/daemon-<host>-<port>.log` under the runtime directory (`hunk daemon status` prints the path).
