import test from "node:test";
import assert from "node:assert/strict";
import { buildRecord } from "./core.mjs";
import { exportJsonBackup, MAX_BACKUP_BYTES, readJsonBackup } from "./backup.mjs";

function backup() {
  return { schemaVersion: 1, exportedAt: "2026-10-29T00:00:00Z", records: [
    buildRecord({ videoId: "video-a", durationSeconds: 120, sources: [{ type: "paste", rawText: "00:10 第一首\n01:00 第二首" }] })
  ] };
}

function replaceGlobal(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
}

test("JSON import preserves schema 1 and accepts a UTF-8 BOM", async () => {
  const payload = backup();
  const blob = new Blob(["\uFEFF", JSON.stringify(payload)], { type: "application/json" });
  assert.deepEqual(await readJsonBackup(blob), JSON.parse(JSON.stringify(payload)));
});

test("oversized files are rejected without reading their contents", async () => {
  let read = false;
  await assert.rejects(readJsonBackup({ size: MAX_BACKUP_BYTES + 1, text() { read = true; } }), /5 MB/);
  assert.equal(read, false);
});

test("non-JSON and invalid backup structures fail before import", async () => {
  for (const text of ["not json", "null", '{"schemaVersion":99,"records":[]}']) {
    await assert.rejects(readJsonBackup(new Blob([text])));
  }
});

test("supported file sharing exports the actual JSON backup", async (t) => {
  const payload = backup();
  let shared;
  replaceGlobal(t, "File", class extends Blob { constructor(parts, name, options) { super(parts, options); this.name = name; } });
  replaceGlobal(t, "navigator", { canShare: ({ files }) => files.length === 1, async share(data) { shared = data; } });
  assert.deepEqual(await exportJsonBackup(payload, "UtaCue.json"), { method: "share" });
  assert.equal(shared.files[0].name, "UtaCue.json");
  assert.deepEqual(JSON.parse(await shared.files[0].text()), JSON.parse(JSON.stringify(payload)));
});

test("cancelling a share does not silently download or report success", async (t) => {
  replaceGlobal(t, "File", class extends Blob { constructor(parts, name, options) { super(parts, options); this.name = name; } });
  replaceGlobal(t, "navigator", { canShare: () => true, async share() { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); } });
  replaceGlobal(t, "document", { createElement() { throw new Error("download must not start"); } });
  assert.deepEqual(await exportJsonBackup(backup(), "UtaCue.json"), { method: "cancelled" });
});

test("export refuses to create a backup larger than the import limit", async () => {
  const payload = backup();
  payload.records[0].sources[0].rawText = "a".repeat(MAX_BACKUP_BYTES + 1);
  await assert.rejects(exportJsonBackup(payload, "UtaCue.json"), /逐部影片匯出/);
});

test("download fallback attaches its link and defers URL revocation for WebKit", async (t) => {
  const calls = [];
  const link = { click() { calls.push("click"); }, remove() { calls.push("remove"); } };
  replaceGlobal(t, "navigator", {});
  replaceGlobal(t, "document", { body: { append(element) { assert.equal(element, link); calls.push("append"); } }, createElement() { return link; } });
  replaceGlobal(t, "setTimeout", (callback, delay) => { assert.equal(delay, 60_000); calls.push("defer"); callback(); });
  assert.deepEqual(await exportJsonBackup(backup(), "UtaCue.json"), { method: "download" });
  assert.deepEqual(calls, ["append", "click", "remove", "defer"]);
  assert.equal(link.download, "UtaCue.json");
  assert.match(link.href, /^blob:/);
});
