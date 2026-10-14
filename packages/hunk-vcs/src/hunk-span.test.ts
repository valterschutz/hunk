import { describe, expect, test } from "bun:test";
import { spanTouchesHunk } from "./hunk-span";

describe("spanTouchesHunk", () => {
  const hunk = { start: 10, count: 7 };

  test("touches a change on the hunk's lines", () => {
    expect(spanTouchesHunk(hunk, { start: 13, count: 1 })).toBe(true);
    expect(spanTouchesHunk(hunk, { start: 8, count: 3 })).toBe(true);
    expect(spanTouchesHunk(hunk, { start: 16, count: 4 })).toBe(true);
  });

  test("ignores a change on lines outside the hunk", () => {
    expect(spanTouchesHunk(hunk, { start: 5, count: 5 })).toBe(false);
    expect(spanTouchesHunk(hunk, { start: 17, count: 2 })).toBe(false);
  });

  test("owns insertions at the boundaries around its lines", () => {
    expect(spanTouchesHunk(hunk, { start: 9, count: 0 })).toBe(true);
    expect(spanTouchesHunk(hunk, { start: 16, count: 0 })).toBe(true);
    expect(spanTouchesHunk(hunk, { start: 8, count: 0 })).toBe(false);
    expect(spanTouchesHunk(hunk, { start: 17, count: 0 })).toBe(false);
  });

  test("matches an empty hunk to the change at its boundary", () => {
    // A new file's old side and a deleted file's new side are both `0,0`.
    expect(spanTouchesHunk({ start: 0, count: 0 }, { start: 0, count: 0 })).toBe(true);
    expect(spanTouchesHunk({ start: 4, count: 0 }, { start: 4, count: 0 })).toBe(true);
    expect(spanTouchesHunk({ start: 4, count: 0 }, { start: 5, count: 0 })).toBe(false);
    // Lines replaced around the boundary belong to the empty hunk too.
    expect(spanTouchesHunk({ start: 4, count: 0 }, { start: 3, count: 2 })).toBe(true);
    expect(spanTouchesHunk({ start: 4, count: 0 }, { start: 7, count: 2 })).toBe(false);
  });
});
