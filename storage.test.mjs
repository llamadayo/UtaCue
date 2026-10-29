import test from "node:test";
import assert from "node:assert/strict";
import { buildRecord, updateEntry } from "./core.mjs";
import { clearAllRecords, exportBackup, importBackup, loadRecord, saveRecord } from "./storage.mjs";

function storageFixture(t, { failWrites = false } = {}) {
  const descriptors = ["browser", "chrome"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const values = { unrelated: { keep: true } };
  const writes = [];
  const local = {
    async get(key) { return structuredClone(key === null ? values : { [key]: values[key] }); },
    async set(items) {
      if (failWrites) throw new Error("QUOTA_BYTES exceeded");
      writes.push(structuredClone(items));
      Object.assign(values, structuredClone(items));
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
  };
  Object.defineProperty(globalThis, "browser", { configurable: true, value: { storage: { local } } });
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get() { throw new Error("wrong namespace"); } } } } });
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { values, writes };
}

function songRecord(videoId = "video-a") {
  return buildRecord({ videoId, durationSeconds: 240, sources: [{ type: "paste", rawText: "00:10 第一首\n01:20 第二首" }] });
}

test("Safari browser storage roundtrips desktop schema 1 with edited cue and unrelated keys intact", async (t) => {
  const { values } = storageFixture(t);
  const initial = songRecord();
  const edited = updateEntry(initial, initial.blocks[0].entries[0].id, { title: "自訂曲名", startSeconds: 12, endSeconds: 70 });
  await saveRecord(edited);
  await saveRecord(songRecord("video-b"));
  const current = await exportBackup("video-a");
  assert.equal(current.schemaVersion, 1);
  assert.equal(current.records.length, 1);
  const all = JSON.parse(JSON.stringify(await exportBackup()));
  await clearAllRecords();
  assert.deepEqual(values, { unrelated: { keep: true } });
  assert.equal(await importBackup(all), 2);
  assert.deepEqual(await loadRecord("video-a"), JSON.parse(JSON.stringify(edited)));
  assert.deepEqual(values.unrelated, { keep: true });
});

test("invalid or ambiguous backups are rejected before any storage write", async (t) => {
  const { writes } = storageFixture(t);
  const record = songRecord();
  await assert.rejects(importBackup({ schemaVersion: 1, records: [record, record] }));
  await assert.rejects(importBackup({ schemaVersion: 1, records: [{ ...record, blocks: [null] }] }));
  assert.equal(writes.length, 0);
});

test("storage quota failure propagates and leaves existing records intact", async (t) => {
  const { values, writes } = storageFixture(t, { failWrites: true });
  const old = songRecord();
  values["setlist:video-a"] = old;
  await assert.rejects(importBackup({ schemaVersion: 1, records: [songRecord("video-b")] }), /QUOTA/);
  assert.equal(writes.length, 0);
  assert.deepEqual(values["setlist:video-a"], old);
  assert.equal(values["setlist:video-b"], undefined);
});

test("corrupt saved data reports an error instead of entering the panel renderer", async (t) => {
  const { values } = storageFixture(t);
  values["setlist:video-a"] = { schemaVersion: 1, videoId: "video-a", sources: [], blocks: [null] };
  await assert.rejects(loadRecord("video-a"), /格式無效/);
});
