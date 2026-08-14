import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("paste dialog close controls bypass required-field validation", async () => {
  const html = await readFile(new URL("./sidepanel.html", import.meta.url), "utf8");
  const pasteForm = html.match(/<form method="dialog" id="paste-form">([\s\S]*?)<\/form>/)?.[1] ?? "";

  assert.match(pasteForm, /aria-label="關閉"[^>]*formnovalidate/);
  assert.match(pasteForm, /value="cancel"[^>]*formnovalidate>取消<\/button>/);
  assert.doesNotMatch(pasteForm, /value="default"[^>]*formnovalidate/);
});
