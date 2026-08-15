import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("side panel controls do not depend on native select popups", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("./sidepanel.html", import.meta.url), "utf8"),
    readFile(new URL("./sidepanel.js", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(html, /<select\b/i);
  assert.match(html, /id="source-trigger"[^>]+aria-haspopup="listbox"/);
  assert.match(html, /id="source-options"[^>]+role="listbox"/);

  for (const [value, label] of [
    ["song", "歌曲"],
    ["chapter", "段落"],
    ["note", "註記"],
    ["hidden", "隱藏"]
  ]) {
    assert.match(html, new RegExp(`type="radio"[^>]+value="${value}"[^>]*><span>${label}</span>`));
  }

  assert.match(script, /sourceOptions\.addEventListener\("click"/);
  assert.match(script, /input\[name="edit-kind"\]:checked/);
});

test("side panel presents the UtaCue brand and purpose", async () => {
  const html = await readFile(new URL("./sidepanel.html", import.meta.url), "utf8");
  await access(new URL("./utacue-icon.png", import.meta.url));

  assert.match(html, /<title>UtaCue<\/title>/);
  assert.match(html, /<h1>UtaCue<\/h1>/);
  assert.match(html, /<p>時間軸小幫手<\/p>/);
  assert.match(html, /<img class="brand-mark"[^>]+src="utacue-icon\.png"/);
});

test("paste dialog close controls bypass required-field validation", async () => {
  const html = await readFile(new URL("./sidepanel.html", import.meta.url), "utf8");
  const pasteForm = html.match(/<form method="dialog" id="paste-form">([\s\S]*?)<\/form>/)?.[1] ?? "";

  assert.match(pasteForm, /aria-label="關閉"[^>]*formnovalidate/);
  assert.match(pasteForm, /value="cancel"[^>]*formnovalidate>取消<\/button>/);
  assert.doesNotMatch(pasteForm, /value="default"[^>]*formnovalidate/);
});
