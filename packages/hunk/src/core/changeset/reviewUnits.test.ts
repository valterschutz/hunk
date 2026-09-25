import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { buildDiffFile } from "./diffFile";
import { projectDiffFilesToReviewUnits } from "./reviewUnits";

const PATCH = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@
 before
-old one
-old two
+new one
+new two
 after
`;

function file() {
  const metadata = parsePatchFiles(PATCH, "patch", true)[0]?.files[0];
  if (!metadata) throw new Error("patch did not parse");
  return buildDiffFile(metadata, PATCH, 0, "test", null);
}

describe("projectDiffFilesToReviewUnits", () => {
  test("keeps standard hunks unchanged in hunk mode", () => {
    const files = [file()];

    expect(projectDiffFilesToReviewUnits(files, "hunk")).toBe(files);
  });

  test("projects changed rows as applicable patch hunks in line mode", () => {
    const [projected] = projectDiffFilesToReviewUnits([file()], "line");

    expect(projected?.metadata.hunks).toHaveLength(2);
    expect(projected?.patch.match(/^@@ /gm)).toHaveLength(2);
    expect(parsePatchFiles(projected!.patch, "patch", true)[0]?.files[0]?.hunks).toHaveLength(2);
  });
});
