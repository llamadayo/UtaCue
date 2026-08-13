export const SCHEMA_VERSION = 1;
export const ENTRY_KINDS = new Set(["song", "chapter", "note", "hidden"]);

const TIMESTAMP_PATTERN = /(^|[^\d])(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?!\d)/;

export function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\-–—・･|｜:：()[\]【】「」『』]+/g, "")
    .trim();
}

export function parseTimestamp(value) {
  const match = String(value).match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  if (match[3] !== undefined) {
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTimestamp(totalSeconds, { padHours = false } = {}) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--:--";
  const rounded = Math.floor(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0 || padHours) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseLine(line) {
  const match = line.match(TIMESTAMP_PATTERN);
  if (!match) return null;
  const token = match[4] === undefined
    ? `${match[2]}:${match[3]}`
    : `${match[2]}:${match[3]}:${match[4]}`;
  const startSeconds = parseTimestamp(token);
  if (startSeconds === null) return null;
  const tokenIndex = match.index + match[1].length;
  const remainder = line
    .slice(tokenIndex + token.length)
    .replace(/^[\s\-–—|｜:：.)\]】]+/, "")
    .trim();
  return {
    originalText: line.trim(),
    originalTitle: remainder || "未命名段落",
    title: remainder || "未命名段落",
    startSeconds
  };
}

export function parseTimeline(rawText, sourceId = "source") {
  const lines = String(rawText ?? "").split(/\r?\n/);
  const parsed = lines.map(parseLine).filter(Boolean);
  const blocks = [];
  let activeBlock = null;
  let previousSeconds = -1;

  for (const item of parsed) {
    if (!activeBlock || item.startSeconds < previousSeconds) {
      activeBlock = {
        id: `${sourceId}:block:${blocks.length + 1}`,
        sourceId,
        order: blocks.length,
        entries: []
      };
      blocks.push(activeBlock);
    }
    const entryIndex = activeBlock.entries.length;
    activeBlock.entries.push({
      id: `${activeBlock.id}:entry:${hashText(`${item.startSeconds}|${item.originalTitle}|${entryIndex}`)}`,
      ...item,
      endSeconds: null,
      kind: "song",
      manuallyEdited: false
    });
    previousSeconds = item.startSeconds;
  }

  return blocks;
}

export function scoreBlock(block) {
  if (!block?.entries?.length) return -1;
  const first = block.entries[0].startSeconds;
  const last = block.entries.at(-1).startSeconds;
  return block.entries.length * 100000 + Math.max(0, last - first);
}

export function selectBestBlock(blocks) {
  return [...blocks].sort((a, b) => scoreBlock(b) - scoreBlock(a))[0] ?? null;
}

export function createSource({ type, rawText, author = "", capturedAt = new Date().toISOString() }) {
  const sourceKey = `${type}|${author}|${String(rawText).trim()}`;
  return {
    id: `source:${hashText(sourceKey)}`,
    type,
    author: author || undefined,
    rawText: String(rawText),
    capturedAt
  };
}

export function buildRecord({ videoId, videoTitle = "", channelName = "", durationSeconds = null, sources = [] }) {
  const normalizedSources = sources
    .filter((source) => source?.rawText?.trim())
    .map((source) => source.id ? source : createSource(source));
  const blocks = normalizedSources.flatMap((source) => parseTimeline(source.rawText, source.id));
  const candidates = normalizedSources.map((source) => {
    const sourceBlocks = blocks.filter((block) => block.sourceId === source.id);
    return { source, bestBlock: selectBestBlock(sourceBlocks) };
  });
  candidates.sort((a, b) => scoreBlock(b.bestBlock) - scoreBlock(a.bestBlock));
  const best = candidates[0];
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    videoId,
    videoTitle,
    channelName,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    activeSourceId: best?.source.id ?? null,
    activeBlockId: best?.bestBlock?.id ?? null,
    sources: normalizedSources,
    blocks,
    overrides: {},
    scannedAt: now,
    updatedAt: now
  };
}

export function getEntry(record, entryId) {
  for (const block of record?.blocks ?? []) {
    const entry = block.entries.find((candidate) => candidate.id === entryId);
    if (entry) return { block, entry };
  }
  return null;
}

export function calculateEntryEnd(record, entryId) {
  const found = getEntry(record, entryId);
  if (!found) return null;
  const { block, entry } = found;
  if (Number.isFinite(entry.endSeconds) && entry.endSeconds > entry.startSeconds) {
    return entry.endSeconds;
  }
  const nextBoundary = block.entries
    .filter((candidate) =>
      candidate.startSeconds > entry.startSeconds
      && (candidate.kind === "song" || candidate.kind === "chapter"))
    .sort((a, b) => a.startSeconds - b.startSeconds)[0];
  if (nextBoundary) return nextBoundary.startSeconds;
  if (Number.isFinite(record.durationSeconds) && record.durationSeconds > entry.startSeconds) {
    return record.durationSeconds;
  }
  return null;
}

function matchEntry(oldRecord, oldBlockOrder, incomingEntry, incomingSource) {
  const titleKey = normalizeTitle(incomingEntry.originalTitle || incomingEntry.title);
  let best = null;
  for (const block of oldRecord?.blocks ?? []) {
    if (block.order !== oldBlockOrder) continue;
    const source = oldRecord.sources.find((candidate) => candidate.id === block.sourceId);
    if (source?.type !== incomingSource?.type || (source?.author ?? "") !== (incomingSource?.author ?? "")) continue;
    for (const entry of block.entries) {
      const oldTitleKey = normalizeTitle(entry.originalTitle || entry.title);
      const timeDelta = Math.abs(entry.startSeconds - incomingEntry.startSeconds);
      if (oldTitleKey === titleKey && timeDelta <= 3 && (!best || timeDelta < best.timeDelta)) {
        best = { entry, timeDelta };
      }
    }
  }
  return best?.entry ?? null;
}

export function diffRecords(existing, incoming) {
  if (!existing) {
    const count = incoming.blocks.reduce((sum, block) => sum + block.entries.length, 0);
    return { added: count, removed: 0, changed: 0 };
  }
  let added = 0;
  let changed = 0;
  const matchedOldIds = new Set();
  for (const block of incoming.blocks) {
    const source = incoming.sources.find((candidate) => candidate.id === block.sourceId);
    for (const entry of block.entries) {
      const oldEntry = matchEntry(existing, block.order, entry, source);
      if (!oldEntry) added += 1;
      else {
        matchedOldIds.add(oldEntry.id);
        const original = oldEntry.manuallyEdited ? parseLine(oldEntry.originalText) : oldEntry;
        if (original?.startSeconds !== entry.startSeconds || original?.originalTitle !== entry.originalTitle) changed += 1;
      }
    }
  }
  const oldCount = existing.blocks.reduce((sum, block) => sum + block.entries.length, 0);
  return { added, removed: Math.max(0, oldCount - matchedOldIds.size), changed };
}

export function mergeRecords(existing, incoming) {
  if (!existing) return incoming;
  const merged = structuredClone(incoming);
  for (const block of merged.blocks) {
    const source = merged.sources.find((candidate) => candidate.id === block.sourceId);
    for (const entry of block.entries) {
      const oldEntry = matchEntry(existing, block.order, entry, source);
      if (oldEntry?.manuallyEdited) {
        entry.title = oldEntry.title;
        entry.startSeconds = oldEntry.startSeconds;
        entry.endSeconds = oldEntry.endSeconds;
        entry.kind = oldEntry.kind;
        entry.manuallyEdited = true;
        merged.overrides[entry.id] = {
          title: entry.title,
          startSeconds: entry.startSeconds,
          endSeconds: entry.endSeconds,
          kind: entry.kind
        };
      }
    }
  }
  merged.updatedAt = new Date().toISOString();
  return merged;
}

export function updateEntry(record, entryId, patch) {
  const copy = structuredClone(record);
  const found = getEntry(copy, entryId);
  if (!found) return copy;
  const allowed = ["title", "startSeconds", "endSeconds", "kind"];
  for (const key of allowed) {
    if (Object.hasOwn(patch, key)) found.entry[key] = patch[key];
  }
  found.entry.manuallyEdited = true;
  copy.overrides[entryId] = Object.fromEntries(allowed.map((key) => [key, found.entry[key]]));
  copy.updatedAt = new Date().toISOString();
  return copy;
}

export function validateRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object") return { valid: false, errors: ["資料必須是物件"] };
  if (record.schemaVersion !== SCHEMA_VERSION) errors.push("不支援的 schemaVersion");
  if (typeof record.videoId !== "string" || !record.videoId) errors.push("缺少 videoId");
  if (!Array.isArray(record.sources)) errors.push("sources 必須是陣列");
  if (!Array.isArray(record.blocks)) errors.push("blocks 必須是陣列");
  for (const block of record.blocks ?? []) {
    if (!Array.isArray(block.entries)) {
      errors.push("block.entries 必須是陣列");
      continue;
    }
    for (const entry of block.entries) {
      if (typeof entry.title !== "string" || !entry.title.trim()) errors.push("項目標題不可為空");
      if (!Number.isFinite(entry.startSeconds) || entry.startSeconds < 0) errors.push("項目開始時間無效");
      if (entry.endSeconds !== null && entry.endSeconds !== undefined
        && (!Number.isFinite(entry.endSeconds) || entry.endSeconds <= entry.startSeconds)) {
        errors.push("項目結束時間無效");
      }
      if (!ENTRY_KINDS.has(entry.kind)) errors.push("項目類型無效");
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateBackup(payload) {
  if (!payload || typeof payload !== "object" || payload.schemaVersion !== SCHEMA_VERSION) {
    return { valid: false, errors: ["備份版本不支援"] };
  }
  if (!Array.isArray(payload.records)) return { valid: false, errors: ["備份缺少 records"] };
  const errors = payload.records.flatMap((record) => validateRecord(record).errors.map((error) => `${record?.videoId ?? "unknown"}: ${error}`));
  return { valid: errors.length === 0, errors };
}
