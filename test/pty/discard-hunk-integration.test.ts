import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

test("d confirms and discards only the selected unstaged hunk", async () => {
  const before = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
  const after = before.replace("line 3\n", "line three\n").replace("line 17\n", "line seventeen\n");
  const fixture = harness.createGitRepoFixture([{ path: "file.txt", before, after }]);
  const session = await harness.launchHunk({
    args: ["diff", "--mode", "unified"],
    cwd: fixture.dir,
    cols: 140,
    rows: 28,
  });

  try {
    await session.waitForText(/line three/, { timeout: 15_000 });
    await harness.ensureKeyboardIsLive(session);
    await harness.pressAndWaitForText(session, "d", /Discard selected hunk\?/, {
      timeout: 5_000,
    });
    await harness.pressAndWaitForSnapshot(
      session,
      "y",
      (text) => !text.includes("Discard selected hunk?") && !text.includes("line three"),
      5_000,
    );

    const contents = readFileSync(join(fixture.dir, "file.txt"), "utf8");
    expect(contents).toContain("line 3\n");
    expect(contents).toContain("line seventeen\n");
  } finally {
    session.close();
  }
});
