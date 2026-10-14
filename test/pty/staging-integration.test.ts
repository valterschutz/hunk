import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** Run one Git command in the fixture repository and return its output. */
function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

/** Poll until the fixture's index satisfies a condition. */
async function waitForIndex(repo: string, predicate: (cached: string) => boolean) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const cached = git(repo, "diff", "--cached");
    if (predicate(cached)) return cached;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the index:\n${cached}`);
    await Bun.sleep(50);
  }
}

test("Space stages and unstages the selected hunk while both stay in the review", async () => {
  const before = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
  const after = before.replace("line 3\n", "line three\n").replace("line 17\n", "line seventeen\n");
  const fixture = harness.createGitRepoFixture([{ path: "file.txt", before, after }]);
  const session = await harness.launchHunk({
    args: ["diff", "--mode", "unified"],
    cwd: fixture.dir,
    cols: 140,
    rows: 40,
  });

  try {
    await session.waitForText(/line seventeen/, { timeout: 15_000 });
    await harness.ensureKeyboardIsLive(session);

    await session.press("space");
    const staged = await waitForIndex(fixture.dir, (cached) => cached.includes("+line three"));
    expect(staged).not.toContain("seventeen");
    // The staged hunk stays in the review instead of leaving it on reload.
    const reloaded = await harness.waitForSnapshot(
      session,
      (text) => text.includes("line three") && text.includes("line seventeen"),
      5_000,
    );
    expect(reloaded).toContain("line three");

    await harness.ensureKeyboardIsLive(session);
    await session.press("space");
    await waitForIndex(fixture.dir, (cached) => cached === "");
    expect(git(fixture.dir, "diff")).toContain("+line three");
  } finally {
    session.close();
  }
});
