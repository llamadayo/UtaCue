import { SCHEMA_VERSION, validateBackup, validateRecord } from "./core.mjs";
import { getExtensionApi } from "./extension-api.mjs";

const PREFIX = "setlist:";

function storageArea() {
  return getExtensionApi()?.storage?.local ?? null;
}

export async function loadRecord(videoId) {
  const area = storageArea();
  if (!area || !videoId) return null;
  const key = `${PREFIX}${videoId}`;
  const result = await area.get(key);
  const record = result[key] ?? null;
  if (record && !validateRecord(record).valid) throw new Error("這部影片的本機歌單格式無效，請從 JSON 備份重新匯入");
  return record;
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
  if (!area) throw new Error("目前無法存取擴充功能的本機儲存空間");
  await area.set(Object.fromEntries(payload.records.map((record) => [`${PREFIX}${record.videoId}`, record])));
  return payload.records.length;
}
