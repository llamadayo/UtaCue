import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import vm from "node:vm";
import * as core from "./core.mjs";

async function panelHarness(sendMessage = async () => ({ ok: true }), options = {}) {
  const nodes = new Map();
  const saved = [];
  const imported = [];
  const messages = [];
  const radios = ["song", "chapter", "note", "hidden"].map((value) => ({ value, checked: false }));
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {
        value: "", textContent: "", hidden: false, disabled: false, open: false,
        handlers: {}, attributes: {},
        classList: { toggle() {} },
        addEventListener(type, callback) { this.handlers[type] = callback; },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name]; },
        closest() { return { classList: { toggle() {} } }; },
        querySelectorAll: () => radios,
        querySelector: () => radios.find((input) => input.checked),
        showModal() { this.open = true; },
        close() { this.open = false; }
      });
      return nodes.get(id);
    }
  };
  const source = await readFile(new URL("./sidepanel.js", import.meta.url), "utf8");
  const extensionApi = {
    storage: { local: {} },
    tabs: {
      query: options.queryTabs ?? (async () => [{ id: 1 }]),
      sendMessage: async (tabId, message) => {
        messages.push({ tabId, ...message });
        return sendMessage(tabId, message);
      }
    }
  };
  const context = vm.createContext({
    ...core,
    document,
    extensionApi,
    isExtensionContext: true,
    confirm: () => true,
    saveRecord: async (record) => { saved.push(record); },
    loadRecord: options.loadRecord ?? (async () => null),
    importBackup: async (payload) => { imported.push(payload); },
    exportBackup: options.exportBackup ?? (async () => ({ schemaVersion: 1, records: [] })),
    exportJsonBackup: options.exportJsonBackup ?? (async () => ({ method: "download" })),
    readJsonBackup: async (file) => JSON.parse(await file.text()),
    deleteRecord: async () => {},
    clearAllRecords: async () => {}
  });
  // Run the actual handlers without starting Chrome initialization or rendering.
  vm.runInContext(source.replace(/^import\s+[\s\S]*?\s+from\s+"[^"]+";\s*/gm, "")
    .replace(/^initialize\(\).*;\s*$/m, "") + `
      render = () => {};
      renderTimeline = () => {};
      renderPlayer = () => {};
      bindEvents();
      globalThis.panel = { state, elements, openEdit, saveEdit, demoMessage,
        restorePlayback, handleRuntimeMessage, switchContext, selectEntry, updateLoop,
        chooseSource, addPastedTimeline, applyImportedBackup, applyPendingScan,
        activeTabMessage, exportBackupFile, clearSelectedPlayback, renderStatus, setStatus, scanPage };
    `, context);
  const panel = context.panel;
  panel.state.record = core.buildRecord({
    videoId: "video-a", durationSeconds: 7200,
    sources: [{ type: "paste", rawText: "08:42 Song A\n20:00 Song B" }]
  });
  panel.state.context = { videoId: "video-a", durationSeconds: 7200, hasVideo: true, canLoop: true };
  panel.state.tabId = 1;
  const entry = panel.state.record.blocks[0].entries[0];
  return { ...panel, entry, saved, imported, messages, nodes };
}

async function editHarness(sendMessage) {
  const panel = await panelHarness(sendMessage);
  const entry = panel.entry;
  panel.openEdit(entry.id);
  return { ...panel, capture: panel.elements.editEndCurrent.handlers.click };
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

test("reopening the popup restores the page-owned selection and loop without mutating playback", async () => {
  let playback;
  const panel = await panelHarness(async (_tabId, message) => {
    assert.equal(message.type, "GET_PLAYBACK_STATE");
    return { ok: true, state: playback };
  });
  playback = {
    videoId: "video-a", currentTime: 610, paused: false,
    selectedEntryId: panel.entry.id,
    loop: { enabled: true, entryId: panel.entry.id, startSeconds: 522, endSeconds: 1200, videoId: "video-a" }
  };
  await panel.restorePlayback();
  assert.equal(panel.state.selectedEntryId, panel.entry.id);
  assert.equal(panel.state.loopEnabled, true);
  assert.equal(panel.state.playback.currentTime, 610);
  playback = { ...playback, paused: true, loop: null };
  await panel.restorePlayback();
  assert.equal(panel.state.selectedEntryId, panel.entry.id);
  assert.equal(panel.state.loopEnabled, false);
  assert.equal(panel.state.playback.paused, true);
  assert.deepEqual(panel.messages.map((message) => message.type), ["GET_PLAYBACK_STATE", "GET_PLAYBACK_STATE"]);
});

test("runtime messages from another tab, frame, or video cannot replace playback", async () => {
  const panel = await panelHarness();
  panel.state.playback.currentTime = 123;
  const message = { type: "PLAYBACK_STATE", state: { videoId: "video-a", currentTime: 456, paused: false } };
  panel.handleRuntimeMessage(message, { tab: { id: 2 }, frameId: 0 });
  panel.handleRuntimeMessage(message, { tab: { id: 1 }, frameId: 9 });
  panel.handleRuntimeMessage({ ...message, state: { ...message.state, videoId: "video-b" } }, { tab: { id: 1 } });
  assert.equal(panel.state.playback.currentTime, 123);
  panel.handleRuntimeMessage({ type: "PAGE_CONTEXT_CHANGED", context: { videoId: "video-b" } }, { tab: { id: 2 } });
  assert.equal(panel.state.context.videoId, "video-a");
  panel.handleRuntimeMessage(message, { tab: { id: 1 }, frameId: 0 });
  assert.equal(panel.state.playback.currentTime, 456);
});

test("a slow previous-video storage read cannot overwrite the current video", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const secondRecord = core.buildRecord({ videoId: "video-b", sources: [{ type: "paste", rawText: "00:10 Song B" }] });
  const panel = await panelHarness(undefined, {
    loadRecord: (videoId) => videoId === "video-a" ? first : Promise.resolve(secondRecord)
  });
  panel.state.context = null;
  panel.elements.editDialog.open = true;
  panel.elements.pasteDialog.open = true;
  panel.state.pendingRecord = panel.state.record;
  const pendingFirst = panel.switchContext({ videoId: "video-a" });
  await panel.switchContext({ videoId: "video-b" });
  resolveFirst(core.buildRecord({ videoId: "video-a", sources: [] }));
  await pendingFirst;
  assert.equal(panel.state.context.videoId, "video-b");
  assert.equal(panel.state.record.videoId, "video-b");
  assert.equal(panel.state.pendingRecord, null);
  assert.equal(panel.elements.editDialog.open, false);
  assert.equal(panel.elements.pasteDialog.open, false);
});

test("messages stay pinned to the popup tab and stale responses are rejected", async () => {
  let complete;
  let queryCount = 0;
  const panel = await panelHarness(() => new Promise((resolve) => { complete = resolve; }), {
    queryTabs: async () => { queryCount += 1; return [{ id: 99 }]; }
  });
  const pending = panel.activeTabMessage({ type: "GET_PLAYBACK_STATE" });
  assert.equal(panel.messages[0].tabId, 1);
  assert.equal(panel.messages[0].videoId, "video-a");
  assert.equal(queryCount, 0);
  panel.state.tabId = 2;
  complete({ ok: true, state: { currentTime: 456, videoId: "video-a" } });
  await assert.rejects(pending, /影片已切換/);
});

test("a scan response for a new video cannot carry over the previous video's pasted sources", async () => {
  const panel = await panelHarness(async () => ({
    ok: true, context: { videoId: "video-b", durationSeconds: 1800 },
    sources: [{ type: "comment", rawText: "00:10 Video B song" }]
  }));
  const previous = panel.state.record;
  await panel.scanPage();
  assert.equal(panel.state.context.videoId, "video-a");
  assert.equal(panel.state.record, previous);
  assert.equal(panel.state.pendingRecord, null);
  assert.equal(panel.saved.length, 0);
  assert.match(panel.elements.statusMessage.textContent, /影片已切換/);
});

test("blocked autoplay keeps the actual paused state, configures the loop, and retains its hint", async () => {
  let playback = { videoId: "video-a", currentTime: 0, paused: true, loop: null, selectedEntryId: null };
  const panel = await panelHarness(async (_tabId, message) => {
    if (message.type === "PLAYER_COMMAND") {
      playback = { ...playback, currentTime: message.seconds, selectedEntryId: message.entryId, loop: message.loop };
      return { ok: true, playbackBlocked: true, message: "請在影片上點一下播放", state: playback };
    }
    return { ok: true, state: playback };
  });
  await panel.selectEntry(panel.entry.id);
  assert.equal(panel.state.playback.paused, true);
  assert.equal(panel.state.loopEnabled, true);
  assert.equal(panel.state.selectedEntryId, panel.entry.id);
  assert.equal(panel.messages[0].type, "PLAYER_COMMAND");
  assert.equal(panel.messages[0].loop.enabled, true);
  assert.equal(panel.messages.some((message) => message.type === "SET_LOOP"), false);
  panel.renderStatus();
  assert.match(panel.elements.statusMessage.textContent, /點一下播放/);
});

test("the first selection command includes its loop before playback resolves", async () => {
  let finishPlayback;
  let playback;
  const panel = await panelHarness(async (_tabId, message) => {
    if (message.type === "PLAYER_COMMAND") {
      playback = { videoId: "video-a", currentTime: message.seconds, paused: true,
        selectedEntryId: message.entryId, loop: message.loop };
      return new Promise((resolve) => { finishPlayback = () => resolve({ ok: true, state: playback }); });
    }
    return { ok: true, state: playback };
  });
  const selection = panel.selectEntry(panel.entry.id);
  assert.equal(panel.messages.length, 1);
  assert.equal(panel.messages[0].type, "PLAYER_COMMAND");
  assert.equal(panel.messages[0].loop.entryId, panel.entry.id);
  assert.equal(panel.messages[0].loop.startSeconds, 522);
  assert.equal(panel.messages[0].loop.endSeconds, 1200);
  assert.equal(panel.messages[0].loop.videoId, "video-a");
  finishPlayback();
  await selection;
  assert.deepEqual(panel.messages.map((message) => message.type), ["PLAYER_COMMAND", "GET_PLAYBACK_STATE"]);
});

test("changing a playing song into a note clears its loop", async () => {
  const panel = await editHarness(async () => ({ ok: true }));
  panel.state.selectedEntryId = panel.entry.id;
  panel.elements.editKind.querySelectorAll().forEach((input) => { input.checked = input.value === "note"; });
  await panel.saveEdit();
  assert.equal(core.getEntry(panel.state.record, panel.entry.id).entry.kind, "note");
  assert.equal(panel.messages.at(-1).type, "CLEAR_LOOP");
  assert.equal(panel.messages.some((message) => message.type === "SET_LOOP"), false);
});

test("pasting, importing, and clearing a current setlist stop its previous page loop", async () => {
  const panel = await panelHarness();
  panel.state.selectedEntryId = panel.entry.id;
  await panel.addPastedTimeline("00:30 New song\n01:30 Another song", "new source");
  assert.equal(panel.messages[0].type, "CLEAR_LOOP");
  assert.equal(panel.messages[0].clearSelection, true);
  assert.equal(panel.state.selectedEntryId, null);
  const currentBackup = { schemaVersion: 1, records: [panel.state.record] };
  const beforeImport = panel.messages.length;
  await panel.applyImportedBackup(currentBackup);
  assert.equal(panel.messages[beforeImport].type, "CLEAR_LOOP");
  assert.equal(panel.imported.length, 1);
  const beforeClear = panel.messages.length;
  await panel.nodes.get("clear-current").handlers.click();
  assert.equal(panel.messages[beforeClear].type, "CLEAR_LOOP");
  assert.equal(panel.state.record, null);
});

test("an unrelated backup import leaves the current playback session alone", async () => {
  const panel = await panelHarness();
  panel.state.selectedEntryId = panel.entry.id;
  const other = core.buildRecord({ videoId: "video-b", sources: [] });
  await panel.applyImportedBackup({ schemaVersion: 1, records: [other] });
  assert.equal(panel.messages.length, 0);
  assert.equal(panel.state.selectedEntryId, panel.entry.id);
  assert.equal(panel.state.record.videoId, "video-a");
});

test("a cancelled share reports cancellation and does not claim a successful export", async () => {
  const panel = await panelHarness(undefined, { exportJsonBackup: async () => ({ method: "cancelled" }) });
  await panel.exportBackupFile(false);
  assert.equal(panel.elements.settingsStatus.textContent, "已取消匯出。");
  assert.equal(panel.nodes.get("export-all").disabled, false);
});
