import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import vm from "node:vm";
import * as core from "./core.mjs";

async function editHarness(sendMessage) {
  const nodes = new Map();
  const saved = [];
  const radios = ["song", "chapter", "note", "hidden"].map((value) => ({ value, checked: false }));
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {
        value: "", textContent: "", hidden: false, disabled: false, open: false,
        handlers: {},
        classList: { toggle() {} },
        addEventListener(type, callback) { this.handlers[type] = callback; },
        querySelectorAll: () => radios,
        querySelector: () => radios.find((input) => input.checked),
        showModal() { this.open = true; },
        close() { this.open = false; }
      });
      return nodes.get(id);
    }
  };
  const source = await readFile(new URL("./sidepanel.js", import.meta.url), "utf8");
  const context = vm.createContext({
    ...core,
    document,
    chrome: { storage: { local: {} }, tabs: { query: async () => [{ id: 1 }], sendMessage } },
    saveRecord: async (record) => { saved.push(record); }
  });
  // Run the actual handlers without starting Chrome initialization or rendering.
  vm.runInContext(source.replace(/^import\s+[\s\S]*?\s+from\s+"[^"]+";\s*/gm, "")
    .replace(/initialize\(\);\s*$/, "") + `
      render = () => {};
      bindEvents();
      globalThis.panel = { state, elements, openEdit, saveEdit, demoMessage };
    `, context);
  const panel = context.panel;
  panel.state.record = core.buildRecord({
    videoId: "video-a", durationSeconds: 7200,
    sources: [{ type: "paste", rawText: "08:42 Song A\n20:00 Song B" }]
  });
  panel.state.context = { videoId: "video-a" };
  const entry = panel.state.record.blocks[0].entries[0];
  panel.openEdit(entry.id);
  return { ...panel, entry, saved, capture: panel.elements.editEndCurrent.handlers.click };
}

test("capture button fills the end time and only saves when confirmed", async () => {
  const html = await readFile(new URL("./sidepanel.html", import.meta.url), "utf8");
  assert.match(html, /id="edit-end-current"[^>]*type="button"/);
  let currentTime = 637.9;
  const panel = await editHarness(async (_tabId, message) => {
    assert.equal(message.type, "GET_PLAYBACK_STATE");
    return { ok: true, state: { currentTime, videoId: "video-a" } };
  });
  panel.state.playback.currentTime = 999;
  await panel.capture();
  assert.equal(panel.elements.editEnd.value, "10:37");
  assert.equal(panel.entry.endSeconds, null);
  assert.equal(panel.saved.length, 0);
  assert.equal(panel.elements.editDialog.open, true);
  currentTime = 3723.8;
  await panel.capture();
  assert.equal(panel.elements.editEnd.value, "01:02:03");
  await panel.saveEdit();
  assert.equal(panel.saved.length, 1);
  assert.equal(core.getEntry(panel.state.record, panel.entry.id).entry.endSeconds, 3723);
});

test("capture failures preserve the edited value and report inside the dialog", async () => {
  for (const response of [
    { ok: true, state: { currentTime: 522.9, videoId: "video-a" } },
    { ok: true, state: { currentTime: 0, videoId: "video-a" } },
    { ok: true, state: { currentTime: 637, videoId: "video-b" } },
    { ok: true, state: { currentTime: NaN, videoId: "video-a" } },
    { ok: true },
    { ok: false, error: "目前頁面找不到播放器" },
    new Error("Disconnected")
  ]) {
    const panel = await editHarness(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    panel.elements.editEnd.value = "12:00";
    await panel.capture();
    assert.equal(panel.elements.editEnd.value, "12:00");
    assert.equal(panel.elements.editStatus.hidden, false);
    assert.ok(panel.elements.editStatus.textContent);
    assert.equal(panel.elements.editEndCurrent.disabled, false);
    assert.equal(panel.saved.length, 0);
  }
});

test("capture validates the current start-time input", async () => {
  const panel = await editHarness(async () => ({ ok: true, state: { currentTime: 637.9, videoId: "video-a" } }));
  for (const value of ["invalid", "10:37", "11:00"]) {
    panel.elements.editStart.value = value;
    panel.elements.editEnd.value = "12:00";
    await panel.capture();
    assert.equal(panel.elements.editEnd.value, "12:00");
    assert.match(panel.elements.editStatus.textContent, /開始時間/);
  }
});

test("late capture responses cannot overwrite a reopened editor", async () => {
  let complete;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const panel = await editHarness(() => new Promise((resolve) => {
    complete = resolve;
    signalStarted();
  }));
  const pending = panel.capture();
  assert.equal(panel.elements.editEndCurrent.disabled, true);
  await started;
  panel.elements.editDialog.close();
  panel.openEdit(panel.entry.id);
  panel.elements.editEnd.value = "13:00";
  complete({ ok: true, state: { currentTime: 637, videoId: "video-a" } });
  await pending;
  assert.equal(panel.elements.editEnd.value, "13:00");
  assert.equal(panel.elements.editStatus.hidden, true);
  assert.equal(panel.elements.editEndCurrent.disabled, false);
});

test("demo capture returns the simulated current video and time", async () => {
  const panel = await editHarness(async () => {});
  panel.state.playback.currentTime = 637.5;
  const response = panel.demoMessage({ type: "GET_PLAYBACK_STATE" });
  assert.equal(response.state.currentTime, 637.5);
  assert.equal(response.state.videoId, "video-a");
});

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
