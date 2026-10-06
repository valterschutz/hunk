import type { HunkExtensionAPI } from "hunkdiff/extension";

/** Route af/aa to host approval commands; the host owns scope, persistence, and confirmation. */
export default function (hunk: HunkExtensionAPI) {
  hunk.registerKeyboardMode({
    id: "approve",
    title: "Approve (a…): f file, a entire review",
    onKey(key, ctx) {
      const text = key.sequence || key.name || "";
      if (!key.ctrl && !key.meta && !key.option) {
        if (text === "f") ctx.commands.execute("hunk.review.approveFile");
        if (text === "a") ctx.commands.execute("hunk.review.approveReview");
      }
      return "exit";
    },
  });
  hunk.registerCommand(
    { id: "prefix", title: "Approve (a…): f file, a entire review", key: "a" },
    (ctx) => {
      ctx.keyboardModes.enterMode("approve");
    },
  );
}
