import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { diffHunkIdentity, diffHunkLines } from "../changeset/hunkDecisions";
import { changesetFromPatch } from "../changeset/fromPatch";
import { openRejections, relocateHunkStart, synthesizeAddressPatch } from "./addressPatch";
import type { HunkRecord, NoteRecord, ReviewRecord } from "./reviewFile";

const BEFORE = lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
const AFTER = BEFORE.replace("line 3\n", "first change\n").replace("line 15\n", "second change\n");

/** Record every hunk of a two-hunk file as rejected. */
function recordedHunks(path = "sample.ts"): HunkRecord[] {
  const file = createTestDiffFile({ after: AFTER, before: BEFORE, context: 2, path });
  return file.metadata.hunks.map((hunk) => ({
    kind: "hunk",
    id: diffHunkIdentity(file, hunk),
    repo: "~/repo",
    path,
    state: "rejected",
    oldStart: hunk.deletionStart,
    newStart: hunk.additionStart,
    lines: diffHunkLines(file, hunk),
  }));
}

describe("openRejections", () => {
  test("selects the repo's rejected hunks in path order with their notes oldest first", () => {
    const [first, second] = recordedHunks();
    const later: NoteRecord = {
      kind: "note",
      id: "user:2",
      source: "user",
      summary: "later",
      editable: true,
      hunk: first!.id,
      side: "new",
      offset: 0,
      length: 1,
      line: 1,
      lineText: "line 1",
      createdAt: "2026-09-24T10:00:01.000Z",
    };
    const earlier: NoteRecord = { ...later, id: "user:1", createdAt: "2026-09-24T10:00:00.000Z" };
    const records: ReviewRecord[] = [
      { ...second!, state: "accepted" },
      { ...first!, repo: "~/other" },
      { ...first!, id: "ffffffffffffffffffffffffffffffff", state: "addressed" },
      first!,
      later,
      earlier,
    ];

    const open = openRejections(records, { repo: "~/repo" });
    expect(open.map((rejection) => rejection.hunk.id)).toEqual([first!.id]);
    expect(open[0]!.notes.map((note) => note.id)).toEqual(["user:1", "user:2"]);

    expect(openRejections(records, { repo: "~/repo", includeAddressed: true })).toHaveLength(2);
    expect(openRejections(records)).toHaveLength(2);
  });
});

describe("relocateHunkStart", () => {
  const hunk = recordedHunks()[1]!;

  test("finds the hunk's new-side rows nearest the recorded start", () => {
    const current = AFTER.split("\n");
    expect(relocateHunkStart(current, hunk.lines!, hunk.newStart)).toBe(hunk.newStart);

    const shifted = ["intro", "intro", "intro", ...current];
    expect(relocateHunkStart(shifted, hunk.lines!, hunk.newStart)).toBe(hunk.newStart + 3);

    const twice = [...current, ...current];
    expect(relocateHunkStart(twice, hunk.lines!, hunk.newStart + 30)).toBe(
      hunk.newStart + current.length,
    );
  });

  test("returns undefined when the rows are gone", () => {
    expect(relocateHunkStart(BEFORE.split("\n"), hunk.lines!, hunk.newStart)).toBeUndefined();
    expect(relocateHunkStart([], hunk.lines!, 1)).toBeUndefined();
  });
});

describe("synthesizeAddressPatch", () => {
  test("parses back into hunks with the recorded identities, one section per hunk", () => {
    const [first, second] = recordedHunks();
    const patch = synthesizeAddressPatch([first!, second!], () => undefined);
    const changeset = changesetFromPatch(patch, "Address", "/repo", null);

    expect(changeset.files).toHaveLength(2);
    expect(changeset.files.map((file) => file.path)).toEqual(["sample.ts", "sample.ts"]);
    changeset.files.forEach((file, index) => {
      expect(file.metadata.hunks).toHaveLength(1);
      expect(diffHunkIdentity(file, file.metadata.hunks[0]!)).toBe([first!, second!][index]!.id);
    });
  });

  test("relocates the new-side start against the current file", () => {
    const [, second] = recordedHunks();
    const current = ["intro", "intro", ...AFTER.split("\n")];
    const patch = synthesizeAddressPatch([second!], (path) =>
      path === "sample.ts" ? current : undefined,
    );
    const [file] = changesetFromPatch(patch, "Address", "/repo", null).files;

    expect(file?.metadata.hunks[0]?.additionStart).toBe(second!.newStart + 2);
    expect(diffHunkIdentity(file!, file!.metadata.hunks[0]!)).toBe(second!.id);
  });

  test("refuses a hunk without recorded lines", () => {
    const [first] = recordedHunks();
    const { lines: _lines, ...withoutLines } = first!;
    expect(() => synthesizeAddressPatch([withoutLines], () => undefined)).toThrow(
      /no recorded lines/,
    );
  });
});
