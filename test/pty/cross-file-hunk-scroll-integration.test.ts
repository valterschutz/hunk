import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
setDefaultTimeout(20_000);
afterEach(() => harness.cleanup());

for (const mode of ["unified", "split"] as const) {
  for (const oneFileAtATime of [true, false]) {
    for (const cursorScroll of ["nearest", "center"] as const) {
      test(`cross-file hunk reveal: ${mode}, one file ${oneFileAtATime}, ${cursorScroll}`, async () => {
        const configHome = harness.createIsolatedConfigHome();
        mkdirSync(join(configHome, "hunk"), { recursive: true });
        writeFileSync(
          join(configHome, "hunk", "config.toml"),
          `one_file_at_a_time = ${oneFileAtATime}\nwhole_file = true\ncursor_scroll = "${cursorScroll}"\nprompt_save_view_preferences = false\n`,
        );
        const before = Array.from({ length: 100 }, (_, index) => `context line ${index + 1}`);
        const after = [...before];
        after[79] = "DESTINATION HUNK VISIBLE";
        const fixture = harness.createGitRepoFixture([
          { path: "a.txt", before: "original\n", after: "FIRST HUNK\n" },
          { path: "b.txt", before: `${before.join("\n")}\n`, after: `${after.join("\n")}\n` },
        ]);
        const session = await harness.launchHunk({
          args: ["diff", "--mode", mode],
          cwd: fixture.dir,
          cols: 120,
          rows: 16,
          env: { XDG_CONFIG_HOME: configHome },
        });
        try {
          await session.waitForText("FIRST HUNK", { timeout: 15_000 });
          // Multi-file startup first mounts folded hunks; wait until source loading has
          // expanded the destination's leading context before testing its distant hunk.
          if (!oneFileAtATime) {
            await harness.waitForSnapshot(
              session,
              (text) =>
                text.includes("context line 1") && !text.includes("DESTINATION HUNK VISIBLE"),
              5_000,
            );
          }
          const destination = await harness.pressAndWaitForSnapshot(
            session,
            "]",
            (text) => text.includes("DESTINATION HUNK VISIBLE"),
            5_000,
          );
          expect(destination).toContain("DESTINATION HUNK VISIBLE");
          const previous = await harness.pressAndWaitForSnapshot(
            session,
            "[",
            (text) => text.includes("FIRST HUNK"),
            5_000,
          );
          expect(previous).toContain("FIRST HUNK");
        } finally {
          session.close();
        }
      });
    }
  }
}
