import { validateBackup } from "./core.mjs";

// A Safari local-storage backup is normally much smaller. Bound parsing work
// before reading an accidentally selected video or an oversized JSON document.
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

export async function readJsonBackup(file) {
  if (!file || typeof file.text !== "function") throw new Error("請選擇 JSON 備份檔");
  if (!Number.isFinite(file.size) || file.size > MAX_BACKUP_BYTES) {
    throw new Error("備份檔過大，請使用 5 MB 以內的 JSON 備份");
  }
  let payload;
  try {
    payload = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("檔案不是有效的 JSON 備份");
  }
  const validation = validateBackup(payload);
  if (!validation.valid) throw new Error(validation.errors.join("、"));
  return payload;
}

export async function exportJsonBackup(payload, filename) {
  const validation = validateBackup(payload);
  if (!validation.valid) throw new Error(validation.errors.join("、"));
  const text = JSON.stringify(payload, null, 2);
  const safeName = String(filename).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-");
  const blob = new Blob([text], { type: "application/json" });
  if (blob.size > MAX_BACKUP_BYTES) throw new Error("備份超過 5 MB，請改為逐部影片匯出，讓備份能在手機重新匯入");
  // Prefer the system share sheet when file sharing is supported. On iPhone
  // this provides "Save to Files" without relying on a persistent popup.
  const file = typeof File === "function" ? new File([blob], safeName, { type: blob.type }) : null;
  const navigator = globalThis.navigator;
  if (file && navigator?.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "UtaCue 歌單備份" });
      return { method: "share" };
    } catch (error) {
      if (error?.name === "AbortError") return { method: "cancelled" };
      // Some extension popups cannot invoke Web Share despite canShare=true.
      // Fall back to the ordinary browser download in that environment.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeName;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Immediate revocation can cancel downloads in WebKit. Let the browser
    // consume the URL; closing the extension document also releases it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return { method: "download" };
}
