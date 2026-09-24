/**
 * Points every test process at an empty XDG_CONFIG_HOME before any test file loads.
 *
 * In-process sessions resolve the same global config path a real run does, so without this the
 * unit suite reads the developer's `~/.config/hunk/config.toml`: theme and reload cases fail
 * against a hand-picked theme, `one_file_at_a_time` changes what the stream shows, and a saved
 * view preference overwrites the real file. Spawned hunk processes inherit the same directory.
 * The directory is left for the OS to sweep; Bun's test runner emits no exit event to clean it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "hunk-test-config-"));
