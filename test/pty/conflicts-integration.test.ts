import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY conflicts", () => {
  test("a rebase conflict is reviewed as ours against theirs and > keeps theirs", async () => {
    const { dir } = harness.createRebaseConflictRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "unified"],
      cwd: dir,
      cols: 120,
      rows: 30,
    });

    try {
      const initial = await session.waitForText(/feature line/, { timeout: 15_000 });
      expect(initial).toContain("main line");
      expect(initial).toContain("(conflict)");
      expect(initial).not.toContain("<<<<<<<");
      // The conflicted file is reviewed first; the ordinary edit follows it.
      expect(initial.indexOf("f.txt")).toBeLessThan(initial.indexOf("other.txt"));

      const resolved = await harness.pressAndWaitForSnapshot(
        session,
        ">",
        (text) => text.includes("(resolved)"),
        10_000,
      );
      expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("alpha\nfeature line\nomega\n");
      // Reloaded as the ordinary edit the merge brought in: theirs added over ours.
      expect(resolved).toContain("feature line");
    } finally {
      session.close();
    }
  });
});
