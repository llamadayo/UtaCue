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

test("record and backup validation reject bad versions and times", () => {
  const record = buildRecord({ videoId: "video", sources: [{ type: "paste", rawText: "0:10 Song" }] });
  assert.equal(validateRecord(record).valid, true);
  assert.equal(validateBackup({ schemaVersion: 1, records: [record] }).valid, true);
  assert.equal(validateBackup({ schemaVersion: 999, records: [record] }).valid, false);
  const invalid = structuredClone(record);
  invalid.blocks[0].entries[0].startSeconds = -1;
  assert.equal(validateRecord(invalid).valid, false);
});
