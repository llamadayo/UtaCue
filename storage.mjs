import { SCHEMA_VERSION, validateBackup, validateRecord } from "./core.mjs";

const PREFIX = "setlist:";

function storageArea() {
  return globalThis.chrome?.storage?.local ?? null;
}

export async function loadRecord(videoId) {
  const area = storageArea();
  if (!area || !videoId) return null;
  const key = `${PREFIX}${videoId}`;
  const result = await area.get(key);
  return result[key] ?? null;
}

export async function saveRecord(record) {
  const validation = validateRecord(record);
  if (!validation.valid) throw new Error(validation.errors.join("、"));
  const area = storageArea();
  if (!area) return record;
  await area.set({ [`${PREFIX}${record.videoId}`]: record });
  return record;
}

export async function deleteRecord(videoId) {
  const area = storageArea();
  if (area && videoId) await area.remove(`${PREFIX}${videoId}`);
}

export async function clearAllRecords() {
  const area = storageArea();
  if (!area) return;
  const values = await area.get(null);
  const keys = Object.keys(values).filter((key) => key.startsWith(PREFIX));
  if (keys.length) await area.remove(keys);
}

export async function exportBackup(videoId = null) {
  const area = storageArea();
  let records = [];
  if (area) {
    const values = await area.get(null);
    records = Object.entries(values)
      .filter(([key, value]) => key.startsWith(PREFIX) && (!videoId || value.videoId === videoId))
      .map(([, value]) => value);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    records
  };
}

export async function importBackup(payload) {
  const validation = validateBackup(payload);
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  const area = storageArea();
  if (area) {
    await area.set(Object.fromEntries(payload.records.map((record) => [`${PREFIX}${record.videoId}`, record])));
  }
  return payload.records.length;
}
