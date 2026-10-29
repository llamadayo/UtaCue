import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecord,
  calculateEntryEnd,
  createSource,
  diffRecords,
  formatTimestamp,
  mergeRecords,
  parseTimeline,
  parseTimestamp,
  selectBestBlock,
  updateEntry,
  validateBackup,
  validateRecord
} from "./core.mjs";

const USER_SAMPLE = `セットリスト🦦💛
らこらっこ
4:05 しっぽ助かる
11:34 とても素敵な六月でした
18:21 あぶく
26:25 アブノーマリティ･ダンシンガール
36:28 青と夏
42:38 恥ずかしいか青春は
48:51 星座になれたら
55:20 踊
1:00:39 唱
1:10:44 Henceforth
1:16:48 スピカ
1:21:44 エルフ
1:40:18 転生林檎
1:53:44 私は最強
2:00:05 夜明けと蛍
らこらっこ
2:07:00 スパチャ読み
2:39:35 しっぽ助かる
らこらっこ
1:29:16 ゆらぎとランチ
1:44:05 りんごも苦手w
1:46:44 トマトは果物w
2:05:40 猫だ
2:09:37 らこらっこらこらっこらこらっこ
2:11:19 いぬ...?`;

test("parses mm:ss and hh:mm:ss strictly", () => {
  assert.equal(parseTimestamp("4:05"), 245);
  assert.equal(parseTimestamp("1:00:39"), 3639);
  assert.equal(parseTimestamp("5:99"), null);
  assert.equal(parseTimestamp("abc"), null);
  assert.equal(formatTimestamp(245), "04:05");
  assert.equal(formatTimestamp(3639), "01:00:39");
});

test("user sample becomes a 17-entry primary block and 6-entry secondary block", () => {
  const blocks = parseTimeline(USER_SAMPLE, "sample");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].entries.length, 17);
  assert.equal(blocks[1].entries.length, 6);
  assert.equal(blocks.flatMap((block) => block.entries).length, 23);
  assert.equal(selectBestBlock(blocks).id, blocks[0].id);
  assert.equal(blocks[0].entries[0].title, "しっぽ助かる");
  assert.equal(blocks[1].entries[0].title, "ゆらぎとランチ");
  assert.ok(blocks.every((block) => block.entries.every((entry) => !entry.title.includes("らこらっこ\n"))));
});

test("supports bullets, duplicate timestamps and ignores malformed timestamps", () => {
  const blocks = parseTimeline(`• 4:05 First\n- 4:05 Duplicate\n5:99 Invalid\n  8:10 — Next`, "edge");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].entries.map((entry) => entry.title), ["First", "Duplicate", "Next"]);
});

test("note does not end a song, chapter does, and secondary blocks never interfere", () => {
  let record = buildRecord({
    videoId: "video",
    durationSeconds: 100,
    sources: [{ type: "paste", rawText: "0:10 Song\n0:20 Event\n0:30 MC\n0:40 Next\n0:15 Overlap note" }]
  });
  const primary = record.blocks[0];
  const [song, event, chapter] = primary.entries;
  record = updateEntry(record, event.id, { kind: "note" });
  record = updateEntry(record, chapter.id, { kind: "chapter" });
  assert.equal(calculateEntryEnd(record, song.id), 30);
  assert.equal(record.blocks.length, 2);
});

test("manual end wins and hidden boundaries are excluded", () => {
  let record = buildRecord({
    videoId: "video",
    durationSeconds: 100,
    sources: [{ type: "paste", rawText: "0:10 Song\n0:20 Hidden\n0:30 Next" }]
  });
  const [song, hidden] = record.blocks[0].entries;
  record = updateEntry(record, hidden.id, { kind: "hidden" });
  assert.equal(calculateEntryEnd(record, song.id), 30);
  record = updateEntry(record, song.id, { endSeconds: 25 });
  assert.equal(calculateEntryEnd(record, song.id), 25);
});

test("last song uses video duration when no later boundary exists", () => {
  const record = buildRecord({
    videoId: "video",
    durationSeconds: 360,
    sources: [{ type: "paste", rawText: "4:05 Last song" }]
  });
  assert.equal(calculateEntryEnd(record, record.blocks[0].entries[0].id), 360);
});

test("rescan merge retains manual title, kind and custom times", () => {
  const source = createSource({ type: "comment", author: "@fan", rawText: "0:10 Song A\n0:30 Song B" });
  let existing = buildRecord({ videoId: "video", durationSeconds: 100, sources: [source] });
  const edited = existing.blocks[0].entries[0];
  existing = updateEntry(existing, edited.id, {
    title: "My Song A",
    startSeconds: 11,
    endSeconds: 28,
    kind: "chapter"
  });

  const incoming = buildRecord({
    videoId: "video",
    durationSeconds: 100,
    sources: [{ type: "comment", author: "@fan", rawText: "0:10 Song A\n0:30 Song B\n0:50 Song C" }]
  });
  assert.deepEqual(diffRecords(existing, incoming), { added: 1, removed: 0, changed: 0 });
  const merged = mergeRecords(existing, incoming);
  const first = merged.blocks[0].entries[0];
  assert.equal(first.title, "My Song A");
  assert.equal(first.startSeconds, 11);
  assert.equal(first.endSeconds, 28);
  assert.equal(first.kind, "chapter");
  assert.equal(first.manuallyEdited, true);
});

test("manual edits never leak between different comment authors", () => {
  let existing = buildRecord({
    videoId: "video",
    sources: [{ type: "comment", author: "@first", rawText: "0:10 Same Song" }]
  });
  existing = updateEntry(existing, existing.blocks[0].entries[0].id, { title: "Edited by user" });
  const incoming = buildRecord({
    videoId: "video",
    sources: [{ type: "comment", author: "@second", rawText: "0:10 Same Song" }]
  });
  const merged = mergeRecords(existing, incoming);
  assert.equal(merged.blocks[0].entries[0].title, "Same Song");
  assert.equal(merged.blocks[0].entries[0].manuallyEdited, false);
});

test("rescan retains a manual start-time correction larger than three seconds", () => {
  let existing = buildRecord({
    videoId: "video", durationSeconds: 100,
    sources: [{ type: "comment", author: "@fan", rawText: "0:10 Song A\n0:50 Song B" }]
  });
  existing = updateEntry(existing, existing.blocks[0].entries[0].id, {
    title: "Corrected Song A", startSeconds: 25, endSeconds: 45, kind: "chapter"
  });
  const incoming = buildRecord({
    videoId: "video", durationSeconds: 100,
    sources: [{ type: "comment", author: "@fan", rawText: "0:10 Song A\n0:50 Song B" }]
  });
  const merged = mergeRecords(existing, incoming);

  assert.deepEqual(diffRecords(existing, incoming), { added: 0, removed: 0, changed: 0 });
  assert.deepEqual(merged.overrides[merged.blocks[0].entries[0].id], {
    title: "Corrected Song A", startSeconds: 25, endSeconds: 45, kind: "chapter"
  });
  assert.equal(merged.blocks[0].entries[0].manuallyEdited, true);
});

test("rescan source drift still uses a three-second limit around the captured source time", () => {
  let existing = buildRecord({
    videoId: "video", sources: [{ type: "comment", author: "@fan", rawText: "0:10 Song A" }]
  });
  existing = updateEntry(existing, existing.blocks[0].entries[0].id, {
    title: "Corrected Song A", startSeconds: 25, endSeconds: 45
  });

  for (const [sourceTime, shouldRetain] of [["0:13", true], ["0:14", false]]) {
    const incoming = buildRecord({
      videoId: "video", sources: [{ type: "comment", author: "@fan", rawText: `${sourceTime} Song A` }]
    });
    const merged = mergeRecords(existing, incoming);
    const first = merged.blocks[0].entries[0];
    assert.equal(first.manuallyEdited, shouldRetain);
    assert.equal(first.title, shouldRetain ? "Corrected Song A" : "Song A");
    assert.deepEqual(diffRecords(existing, incoming), shouldRetain
      ? { added: 0, removed: 0, changed: 1 }
      : { added: 1, removed: 1, changed: 0 });
  }
});

test("record and backup validation reject bad versions and times", () => {
  const record = buildRecord({ videoId: "video", sources: [{ type: "paste", rawText: "0:10 Song" }] });
  assert.equal(validateRecord(record).valid, true);
  assert.equal(validateBackup({ schemaVersion: 1, records: [record] }).valid, true);
  assert.equal(validateBackup({ schemaVersion: 999, records: [record] }).valid, false);
  const invalid = structuredClone(record);
  invalid.blocks[0].entries[0].startSeconds = -1;
  assert.equal(validateRecord(invalid).valid, false);
});

function backupRecord() {
  return buildRecord({
    videoId: "video-a",
    videoTitle: "歌回",
    durationSeconds: 120,
    sources: [{ type: "paste", rawText: "0:10 Song A\n0:50 Song B" }]
  });
}

test("schema-1 JSON backups retain manual edits and usable boundaries after a round trip", () => {
  let record = backupRecord();
  const entryId = record.blocks[0].entries[0].id;
  record = updateEntry(record, entryId, { title: "手動修正", startSeconds: 12, endSeconds: 48 });
  const json = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), records: [record] });
  const restored = JSON.parse(json);

  assert.deepEqual(validateBackup(restored), { valid: true, errors: [] });
  assert.equal(restored.records[0].blocks[0].entries[0].title, "手動修正");
  assert.equal(calculateEntryEnd(restored.records[0], entryId), 48);
  assert.deepEqual(restored.records[0].overrides[entryId], {
    title: "手動修正", startSeconds: 12, endSeconds: 48, kind: "song"
  });
  assert.equal(JSON.stringify(restored), json);
});

test("schema-1 records without an override index can still be imported and edited", () => {
  const record = JSON.parse(JSON.stringify(backupRecord()));
  delete record.overrides;
  assert.equal(validateRecord(record).valid, true);

  const entryId = record.blocks[0].entries[0].id;
  const edited = updateEntry(record, entryId, { title: "Edited after import" });
  assert.equal(edited.overrides[entryId].title, "Edited after import");
  assert.equal(validateBackup({ schemaVersion: 1, records: [edited] }).valid, true);
});

test("re-pasting an identical source keeps one timeline and preserves earlier manual edits", () => {
  let existing = backupRecord();
  const entryId = existing.blocks[0].entries[0].id;
  existing = updateEntry(existing, entryId, { title: "My Song A", endSeconds: 45 });
  const repeatedSource = createSource({ type: "paste", rawText: "0:10 Song A\n0:50 Song B" });
  const incoming = buildRecord({
    videoId: existing.videoId,
    durationSeconds: existing.durationSeconds,
    sources: [...existing.sources, repeatedSource]
  });
  const merged = mergeRecords(existing, incoming);

  assert.equal(merged.sources.length, 1);
  assert.equal(merged.blocks.length, 1);
  assert.equal(merged.blocks[0].entries.length, 2);
  assert.equal(merged.blocks[0].entries[0].title, "My Song A");
  assert.equal(calculateEntryEnd(merged, entryId), 45);
  assert.deepEqual(diffRecords(existing, incoming), { added: 0, removed: 0, changed: 0 });
  assert.equal(validateBackup(JSON.parse(JSON.stringify({ schemaVersion: 1, records: [merged] }))).valid, true);
});

test("malformed JSON record shapes are rejected without throwing", () => {
  const mutations = [
    (record) => { record.videoId = {}; },
    (record) => { record.videoTitle = {}; },
    (record) => { record.durationSeconds = "120"; },
    (record) => { record.sources = {}; },
    (record) => { record.sources = [null]; },
    (record) => { record.sources[0].rawText = []; },
    (record) => { record.sources[0].author = {}; },
    (record) => { record.blocks = {}; },
    (record) => { record.blocks = "invalid"; },
    (record) => { record.blocks = [null]; },
    (record) => { record.blocks[0].order = -1; },
    (record) => { record.blocks[0].entries = {}; },
    (record) => { record.blocks[0].entries = [null]; },
    (record) => { record.blocks[0].entries = [[]]; },
    (record) => { delete record.blocks[0].entries[0].id; },
    (record) => { record.blocks[0].entries[0].originalText = {}; },
    (record) => { record.blocks[0].entries[0].manuallyEdited = true; delete record.blocks[0].entries[0].originalText; },
    (record) => { record.overrides = null; },
    (record) => { record.overrides = []; }
  ];
  const malformed = [null, [], false, 1, "invalid", ...mutations.map((mutate) => {
    const record = backupRecord();
    mutate(record);
    return record;
  })];

  for (const record of malformed) {
    assert.doesNotThrow(() => validateRecord(record));
    assert.equal(validateRecord(record).valid, false);
    const payload = JSON.parse(JSON.stringify({ schemaVersion: 1, records: [record] }));
    assert.doesNotThrow(() => validateBackup(payload));
    assert.equal(validateBackup(payload).valid, false);
  }
  for (const payload of [null, [], {}, { schemaVersion: 1, records: {} }]) {
    assert.doesNotThrow(() => validateBackup(payload));
    assert.equal(validateBackup(payload).valid, false);
  }
});

test("ambiguous record IDs and invalid references cannot enter a backup", () => {
  const mutations = [
    (record) => { record.sources.push(structuredClone(record.sources[0])); },
    (record) => { record.blocks.push(structuredClone(record.blocks[0])); },
    (record) => { record.blocks[0].entries.push(structuredClone(record.blocks[0].entries[0])); },
    (record) => { record.blocks[0].entries[0].id = record.sources[0].id; },
    (record) => { record.blocks[0].sourceId = "missing-source"; },
    (record) => { record.activeSourceId = "missing-source"; },
    (record) => { record.activeBlockId = "missing-block"; },
    (record) => { record.activeSourceId = null; }
  ];
  for (const mutate of mutations) {
    const record = backupRecord();
    mutate(record);
    assert.equal(validateBackup({ schemaVersion: 1, records: [record] }).valid, false);
  }

  const first = backupRecord();
  const second = updateEntry(first, first.blocks[0].entries[0].id, { title: "Conflicting replacement" });
  const result = validateBackup({ schemaVersion: 1, records: [first, second] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /重複的 videoId/);
});

test("prototype-related keys are rejected and editing cannot invoke the prototype setter", () => {
  for (const unsafeId of ["__proto__", "constructor", "prototype"]) {
    const record = backupRecord();
    record.blocks[0].entries[0].id = unsafeId;
    assert.equal(validateRecord(record).valid, false);

    const edited = updateEntry(record, unsafeId, { title: "Unsafe ID" });
    assert.equal(Object.getPrototypeOf(edited.overrides), Object.prototype);
    assert.equal(Object.hasOwn(edited.overrides, unsafeId), true);
    assert.equal(validateRecord(edited).valid, false);

    const unsafeRecord = backupRecord();
    unsafeRecord.videoId = unsafeId;
    assert.equal(validateRecord(unsafeRecord).valid, false);

    const payload = JSON.parse(JSON.stringify({ schemaVersion: 1, records: [backupRecord()] }));
    payload.records[0].overrides = Object.fromEntries([[unsafeId, { title: "Unsafe override" }]]);
    assert.equal(validateBackup(payload).valid, false);
  }

  const recordWithUnsafeOwnKey = JSON.parse(JSON.stringify(backupRecord()).replace('{', '{"__proto__":{},'));
  assert.equal(validateRecord(recordWithUnsafeOwnKey).valid, false);
  assert.equal(validateRecord(Object.create(backupRecord())).valid, false);
});

test("invalid override shapes or references are rejected before later edits or rescans", () => {
  const invalidOverrides = [
    null, [], "invalid", { title: "" }, { startSeconds: -1 },
    { startSeconds: null }, { endSeconds: "40" }, { endSeconds: 5 },
    { kind: "unknown" }, JSON.parse('{"__proto__":{}}')
  ];
  for (const override of invalidOverrides) {
    const record = backupRecord();
    record.overrides[record.blocks[0].entries[0].id] = override;
    assert.doesNotThrow(() => validateRecord(record));
    assert.equal(validateRecord(record).valid, false);
  }
  const record = backupRecord();
  record.overrides["missing-entry"] = { title: "No matching entry" };
  assert.equal(validateRecord(record).valid, false);
});
