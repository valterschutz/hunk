---
"hunkdiff": patch
---

Maintenance only: the unit suite isolates `XDG_CONFIG_HOME` through a bunfig preload, the installer tests resolve their utilities from PATH instead of assuming `/usr/bin`, and the Jujutsu source-failure test skips without `jj`.
