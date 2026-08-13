import {
  buildRecord,
  calculateEntryEnd,
  createSource,
  diffRecords,
  formatTimestamp,
  getEntry,
  mergeRecords,
  parseTimestamp,
  scoreBlock,
  selectBestBlock,
  updateEntry,
  validateBackup
} from "./core.mjs";
import {
  clearAllRecords,
  deleteRecord,
  exportBackup,
  importBackup,
  loadRecord,
  saveRecord
} from "./storage.mjs";

const isExtension = Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.tabs);
const FALLBACK_THUMBNAIL = "fallback-thumbnail.png";
const DEMO_TIMELINE = `00:03:18 星のかけら
00:08:42 夜に駆ける
00:14:10 花のように
00:19:55 Blue Moon
00:25:30 MC / 雑談`;

const state = {
  context: null,
  record: null,
  selectedEntryId: null,
  loopEnabled: true,
  showHidden: false,
  playback: { currentTime: 0, paused: true },
  pendingRecord: null,
  demoTimer: null
};

const elements = Object.fromEntries([
  "app", "video-thumbnail", "video-title", "video-channel", "video-duration",
  "source-select", "scan-button", "status-message", "show-hidden", "empty-state",
  "timeline", "player-panel", "now-title", "now-range", "loop-toggle", "progress",
  "progress-current", "progress-end", "play-button", "previous-button", "next-button",
  "paste-dialog", "paste-form", "paste-author", "paste-text", "edit-dialog", "edit-form",
  "edit-id", "edit-title", "edit-start", "edit-end", "edit-kind", "diff-dialog", "diff-form",
  "diff-added", "diff-changed", "diff-removed", "settings-dialog", "settings-status",
  "import-file"
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

function icon(name) {
  const paths = {
    edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-3L4 17v3ZM13.5 7.5l3 3"/>',
    play: '<path d="m9 6 9 6-9 6V6Z"/>',
    chapter: '<path d="M5 6h14M5 12h9M5 18h14"/>',
    note: '<path d="M12 5v11M12 8l7-2v8M8 16a3 2 0 1 0 0 4 3 2 0 0 0 0-4ZM19 12a3 2 0 1 0 0 4 3 2 0 0 0 0-4Z"/>',
    hidden: '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.7 10.7 0 0 1 21 12a13 13 0 0 1-2.1 3.2M6.6 6.6A12.7 12.7 0 0 0 3 12s3.2 6 9 6a9 9 0 0 0 3-.5"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.edit}</svg>`;
}

function sourceLabel(source) {
  if (source.type === "description") return "影片說明欄";
  if (source.type === "comment") return `留言${source.author ? `｜${source.author}` : ""}`;
  return `貼上內容${source.author ? `｜${source.author}` : ""}`;
}

function kindLabel(kind) {
  return { song: "歌曲", chapter: "段落", note: "註記", hidden: "隱藏" }[kind] ?? kind;
}

function relativeUpdatedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function setStatus(message, type = "neutral") {
  elements.statusMessage.textContent = message;
  const row = elements.statusMessage.closest(".status-row");
  row.classList.toggle("success", type === "success");
  row.classList.toggle("error", type === "error");
}

async function activeTabMessage(message) {
  if (!isExtension) return demoMessage(message);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到目前分頁");
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) throw new Error(response?.error || "YouTube 頁面沒有回應");
    return response;
  } catch (error) {
    throw new Error("請在 YouTube 影片頁重新整理一次，再開啟側邊面板");
  }
}

function demoMessage(message) {
  if (message.type === "GET_CONTEXT") return { ok: true, context: state.context };
  if (message.type === "PLAYER_COMMAND") {
    if (message.command === "seek") state.playback.currentTime = Number(message.seconds) || 0;
    if (message.command === "toggle") state.playback.paused = !state.playback.paused;
    if (message.command === "play") state.playback.paused = false;
    if (message.command === "pause") state.playback.paused = true;
    renderPlayer();
    return { ok: true };
  }
  if (message.type === "SCAN_PAGE") {
    return { ok: true, context: state.context, sources: [{ type: "comment", author: "@music_fan", rawText: DEMO_TIMELINE }] };
  }
  return { ok: true };
}

function activeSource() {
  return state.record?.sources.find((source) => source.id === state.record.activeSourceId) ?? null;
}

function activeBlock() {
  return state.record?.blocks.find((block) => block.id === state.record.activeBlockId) ?? null;
}

function visibleSongCount() {
  return activeBlock()?.entries.filter((entry) => entry.kind === "song").length ?? 0;
}

function renderContext() {
  const context = state.context;
  elements.videoTitle.textContent = context?.videoTitle || "請開啟 YouTube 影片";
  elements.videoChannel.textContent = context?.channelName || (context?.videoId ? "YouTube 影片" : "等待影片資訊");
  elements.videoDuration.textContent = Number.isFinite(context?.durationSeconds)
    ? formatTimestamp(context.durationSeconds, { padHours: context.durationSeconds >= 3600 })
    : (context?.isLive ? "直播進行中" : "--:--");
  elements.videoThumbnail.src = context?.thumbnailUrl || FALLBACK_THUMBNAIL;
}

function renderSources() {
  elements.sourceSelect.replaceChildren();
  if (!state.record?.sources.length) {
    elements.sourceSelect.add(new Option("尚無來源", ""));
    elements.sourceSelect.disabled = true;
    return;
  }
  for (const source of state.record.sources) {
    const option = new Option(sourceLabel(source), source.id);
    option.selected = source.id === state.record.activeSourceId;
    elements.sourceSelect.add(option);
  }
  elements.sourceSelect.disabled = false;
}

function createTimelineRow(entry, block) {
  const row = document.createElement("div");
  row.className = `timeline-row is-${entry.kind}`;
  row.dataset.entryId = entry.id;
  row.dataset.blockId = block.id;
  row.classList.toggle("selected", entry.id === state.selectedEntryId);

  const main = document.createElement("button");
  main.type = "button";
  main.className = "row-main";
  main.dataset.action = "select-entry";
  main.setAttribute("aria-label", `${formatTimestamp(entry.startSeconds)} ${entry.title}`);

  const time = document.createElement("span");
  time.className = "row-time";
  time.textContent = formatTimestamp(entry.startSeconds, { padHours: entry.startSeconds >= 3600 });
  const titleWrap = document.createElement("span");
  titleWrap.className = "row-title-wrap";
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = entry.title;
  const kind = document.createElement("span");
  kind.className = "row-kind";
  kind.textContent = kindLabel(entry.kind);
  titleWrap.append(title, kind);
  main.append(time, titleWrap);

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "edit-row";
  edit.dataset.action = "edit-entry";
  edit.setAttribute("aria-label", `編輯 ${entry.title}`);
  edit.innerHTML = icon("edit");
  row.append(main, edit);
  return row;
}

function appendBlockEntries(container, block) {
  const entries = block.entries.filter((entry) => state.showHidden || entry.kind !== "hidden");
  if (!entries.length) {
    const message = document.createElement("p");
    message.className = "form-hint";
    message.style.padding = "20px";
    message.textContent = "這個區塊目前沒有可顯示的項目。";
    container.append(message);
    return;
  }
  entries.forEach((entry) => container.append(createTimelineRow(entry, block)));
}

function renderTimeline() {
  elements.timeline.replaceChildren();
  const record = state.record;
  const block = activeBlock();
  const hasEntries = Boolean(record && block?.entries.length);
  elements.emptyState.hidden = hasEntries;
  elements.timeline.hidden = !hasEntries;
  elements.app.classList.toggle("has-record", hasEntries);
  if (!hasEntries) return;

  const heading = document.createElement("div");
  heading.className = "block-heading";
  heading.innerHTML = `<span>主要時間軸・${block.entries.length} 項</span>`;
  elements.timeline.append(heading);
  appendBlockEntries(elements.timeline, block);

  const siblingBlocks = record.blocks.filter((candidate) =>
    candidate.sourceId === record.activeSourceId && candidate.id !== record.activeBlockId);
  siblingBlocks.forEach((candidate, index) => {
    const details = document.createElement("details");
    details.className = "secondary-block";
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.textContent = `附加時間軸 ${index + 1}・${candidate.entries.length} 項`;
    const promote = document.createElement("button");
    promote.type = "button";
    promote.dataset.action = "promote-block";
    promote.dataset.blockId = candidate.id;
    promote.textContent = "設為主要";
    summary.append(label, promote);
    details.append(summary);
    appendBlockEntries(details, candidate);
    elements.timeline.append(details);
  });
}

function selectedEntry() {
  return getEntry(state.record, state.selectedEntryId)?.entry ?? null;
}

function renderPlayer() {
  const entry = selectedEntry();
  const isSong = entry?.kind === "song";
  elements.playerPanel.hidden = !isSong;
  if (!isSong) return;
  const end = calculateEntryEnd(state.record, entry.id);
  elements.nowTitle.textContent = entry.title;
  elements.nowRange.textContent = `${formatTimestamp(entry.startSeconds)} — ${formatTimestamp(end)}`;
  elements.loopToggle.checked = state.loopEnabled;
  elements.loopToggle.disabled = !end || !state.context?.canLoop;
  elements.playButton.classList.toggle("paused", state.playback.paused);
  const current = Math.max(entry.startSeconds, state.playback.currentTime || entry.startSeconds);
  const range = end ? end - entry.startSeconds : 0;
  const position = range > 0 ? Math.min(1, Math.max(0, (current - entry.startSeconds) / range)) : 0;
  elements.progress.value = Math.round(position * 1000);
  elements.progressCurrent.textContent = formatTimestamp(current);
  elements.progressEnd.textContent = formatTimestamp(end);
}

function renderStatus() {
  if (!state.context?.videoId) {
    setStatus("請先開啟一部 YouTube 影片", "error");
    return;
  }
  if (!state.record) {
    setStatus("尚未建立歌單");
    return;
  }
  const count = visibleSongCount();
  setStatus(`已找到 ${count} 首・更新於 ${relativeUpdatedAt(state.record.updatedAt)}`, "success");
}

function render() {
  renderContext();
  renderSources();
  renderTimeline();
  renderPlayer();
  renderStatus();
}

async function persist(record = state.record) {
  if (!record) return;
  state.record = record;
  if (isExtension) await saveRecord(record);
  render();
}

async function switchContext(context) {
  const changed = context?.videoId !== state.context?.videoId;
  state.context = context;
  if (!changed) {
    if (state.record && Number.isFinite(context?.durationSeconds)) state.record.durationSeconds = context.durationSeconds;
    render();
    return;
  }
  state.selectedEntryId = null;
  state.playback = { currentTime: 0, paused: true };
  state.record = context?.videoId && isExtension ? await loadRecord(context.videoId) : null;
  render();
}

async function scanPage() {
  if (!state.context?.videoId) {
    setStatus("請先開啟一部 YouTube 影片", "error");
    return;
  }
  setStatus("正在掃描已載入的說明欄與留言…");
  elements.scanButton.disabled = true;
  try {
    const response = await activeTabMessage({ type: "SCAN_PAGE" });
    state.context = response.context || state.context;
    const preservedPasteSources = state.record?.sources.filter((source) => source.type === "paste") ?? [];
    const incoming = buildRecord({
      ...state.context,
      sources: [...preservedPasteSources, ...(response.sources ?? [])]
    });
    const entryCount = incoming.blocks.reduce((sum, block) => sum + block.entries.length, 0);
    if (!entryCount) {
      setStatus("找不到時間戳；請先往下捲動載入留言，或直接貼上時間軸", "error");
      return;
    }
    if (!state.record) {
      await persist(incoming);
      return;
    }
    const diff = diffRecords(state.record, incoming);
    state.pendingRecord = mergeRecords(state.record, incoming);
    elements.diffAdded.textContent = diff.added;
    elements.diffChanged.textContent = diff.changed;
    elements.diffRemoved.textContent = diff.removed;
    elements.diffDialog.showModal();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.scanButton.disabled = false;
  }
}

async function addPastedTimeline(rawText, author) {
  if (!state.context?.videoId) throw new Error("請先開啟一部 YouTube 影片");
  const source = createSource({ type: "paste", rawText, author });
  const incoming = buildRecord({
    ...state.context,
    sources: [...(state.record?.sources ?? []), source]
  });
  const sourceBlocks = incoming.blocks.filter((block) => block.sourceId === source.id);
  if (!sourceBlocks.length) throw new Error("貼上的文字中找不到有效時間戳");
  const merged = mergeRecords(state.record, incoming);
  merged.activeSourceId = source.id;
  merged.activeBlockId = selectBestBlock(sourceBlocks)?.id ?? null;
  state.selectedEntryId = null;
  await persist(merged);
}

async function selectEntry(entryId) {
  const found = getEntry(state.record, entryId);
  if (!found) return;
  state.selectedEntryId = entryId;
  state.playback.currentTime = found.entry.startSeconds;
  state.playback.paused = false;
  const end = calculateEntryEnd(state.record, entryId);
  try {
    await activeTabMessage({ type: "PLAYER_COMMAND", command: "seek", seconds: found.entry.startSeconds, play: true });
    if (found.entry.kind === "song" && state.loopEnabled && end && state.context?.canLoop) {
      await activeTabMessage({ type: "SET_LOOP", enabled: true, startSeconds: found.entry.startSeconds, endSeconds: end, entryId });
    } else {
      await activeTabMessage({ type: "CLEAR_LOOP" });
    }
  } catch (error) {
    setStatus(error.message, "error");
  }
  render();
}

async function updateLoop() {
  const entry = selectedEntry();
  const end = entry ? calculateEntryEnd(state.record, entry.id) : null;
  if (entry && state.loopEnabled && end && state.context?.canLoop) {
    await activeTabMessage({ type: "SET_LOOP", enabled: true, startSeconds: entry.startSeconds, endSeconds: end, entryId: entry.id });
  } else {
    await activeTabMessage({ type: "CLEAR_LOOP" });
  }
}

async function moveSong(direction) {
  const block = activeBlock();
  const songs = block?.entries.filter((entry) => entry.kind === "song") ?? [];
  if (!songs.length) return;
  const currentIndex = songs.findIndex((entry) => entry.id === state.selectedEntryId);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + songs.length) % songs.length;
  await selectEntry(songs[nextIndex].id);
}

function openEdit(entryId) {
  const entry = getEntry(state.record, entryId)?.entry;
  if (!entry) return;
  elements.editId.value = entry.id;
  elements.editTitle.value = entry.title;
  elements.editStart.value = formatTimestamp(entry.startSeconds, { padHours: entry.startSeconds >= 3600 });
  elements.editEnd.value = Number.isFinite(entry.endSeconds)
    ? formatTimestamp(entry.endSeconds, { padHours: entry.endSeconds >= 3600 }) : "";
  elements.editKind.value = entry.kind;
  elements.editDialog.showModal();
}

async function saveEdit() {
  const startSeconds = parseTimestamp(elements.editStart.value.trim());
  const endValue = elements.editEnd.value.trim();
  const endSeconds = endValue ? parseTimestamp(endValue) : null;
  if (startSeconds === null) throw new Error("開始時間格式不正確");
  if (endValue && (endSeconds === null || endSeconds <= startSeconds)) throw new Error("結束時間必須晚於開始時間");
  const updated = updateEntry(state.record, elements.editId.value, {
    title: elements.editTitle.value.trim(),
    startSeconds,
    endSeconds,
    kind: elements.editKind.value
  });
  await persist(updated);
  if (state.selectedEntryId === elements.editId.value) await updateLoop();
}

function downloadJson(payload, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function backupPayload(currentOnly) {
  if (isExtension) return exportBackup(currentOnly ? state.context?.videoId : null);
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), records: state.record ? [state.record] : [] };
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function bindEvents() {
  document.getElementById("header-settings").addEventListener("click", () => openDialog(elements.settingsDialog));
  document.getElementById("footer-settings").addEventListener("click", () => openDialog(elements.settingsDialog));
  document.getElementById("paste-open").addEventListener("click", () => openDialog(elements.pasteDialog));
  document.getElementById("empty-paste").addEventListener("click", () => openDialog(elements.pasteDialog));
  document.getElementById("empty-scan").addEventListener("click", scanPage);
  document.getElementById("footer-scan").addEventListener("click", scanPage);
  elements.scanButton.addEventListener("click", scanPage);
  elements.videoThumbnail.addEventListener("error", () => { elements.videoThumbnail.src = FALLBACK_THUMBNAIL; });

  elements.sourceSelect.addEventListener("change", async () => {
    state.record.activeSourceId = elements.sourceSelect.value;
    state.record.activeBlockId = selectBestBlock(state.record.blocks.filter((block) => block.sourceId === elements.sourceSelect.value))?.id ?? null;
    state.selectedEntryId = null;
    await persist(state.record);
  });
  elements.showHidden.addEventListener("change", () => {
    state.showHidden = elements.showHidden.checked;
    renderTimeline();
  });

  elements.timeline.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "select-entry") await selectEntry(action.closest(".timeline-row").dataset.entryId);
    if (action.dataset.action === "edit-entry") openEdit(action.closest(".timeline-row").dataset.entryId);
    if (action.dataset.action === "promote-block") {
      event.preventDefault();
      event.stopPropagation();
      state.record.activeBlockId = action.dataset.blockId;
      state.selectedEntryId = null;
      await persist(state.record);
    }
  });

  elements.loopToggle.addEventListener("change", async () => {
    state.loopEnabled = elements.loopToggle.checked;
    try { await updateLoop(); } catch (error) { setStatus(error.message, "error"); }
    renderPlayer();
  });
  elements.playButton.addEventListener("click", async () => {
    try { await activeTabMessage({ type: "PLAYER_COMMAND", command: "toggle" }); }
    catch (error) { setStatus(error.message, "error"); }
  });
  elements.previousButton.addEventListener("click", () => moveSong(-1));
  elements.nextButton.addEventListener("click", () => moveSong(1));
  elements.progress.addEventListener("input", async () => {
    const entry = selectedEntry();
    const end = entry ? calculateEntryEnd(state.record, entry.id) : null;
    if (!entry || !end) return;
    const seconds = entry.startSeconds + (end - entry.startSeconds) * (Number(elements.progress.value) / 1000);
    state.playback.currentTime = seconds;
    renderPlayer();
    try { await activeTabMessage({ type: "PLAYER_COMMAND", command: "seek", seconds, play: false }); }
    catch (error) { setStatus(error.message, "error"); }
  });

  elements.pasteForm.addEventListener("submit", async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    try {
      await addPastedTimeline(elements.pasteText.value, elements.pasteAuthor.value.trim());
      elements.pasteDialog.close();
      elements.pasteForm.reset();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
  elements.editForm.addEventListener("submit", async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    try { await saveEdit(); elements.editDialog.close(); }
    catch (error) { setStatus(error.message, "error"); }
  });
  elements.diffForm.addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "cancel" && state.pendingRecord) {
      event.preventDefault();
      await persist(state.pendingRecord);
      state.pendingRecord = null;
      elements.diffDialog.close();
    } else state.pendingRecord = null;
  });

  document.getElementById("export-current").addEventListener("click", async () => {
    const payload = await backupPayload(true);
    downloadJson(payload, `歌枠時間軸-${state.context?.videoId || "current"}.json`);
    elements.settingsStatus.textContent = `已匯出 ${payload.records.length} 份歌單。`;
  });
  document.getElementById("export-all").addEventListener("click", async () => {
    const payload = await backupPayload(false);
    downloadJson(payload, "歌枠時間軸-backup.json");
    elements.settingsStatus.textContent = `已匯出 ${payload.records.length} 份歌單。`;
  });
  elements.importFile.addEventListener("change", async () => {
    const file = elements.importFile.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const validation = validateBackup(payload);
      if (!validation.valid) throw new Error(validation.errors.join("、"));
      const confirmed = confirm(`即將匯入 ${payload.records.length} 份歌單；相同影片會以匯入資料取代。是否繼續？`);
      if (!confirmed) return;
      if (isExtension) await importBackup(payload);
      const importedCurrent = payload.records.find((record) => record.videoId === state.context?.videoId);
      if (importedCurrent) state.record = importedCurrent;
      elements.settingsStatus.textContent = `已匯入 ${payload.records.length} 份歌單。`;
      render();
    } catch (error) {
      elements.settingsStatus.textContent = `匯入失敗：${error.message}`;
    } finally {
      elements.importFile.value = "";
    }
  });
  document.getElementById("clear-current").addEventListener("click", async () => {
    if (!state.context?.videoId || !confirm("確定清除目前影片的歌單？此操作無法復原。")) return;
    if (isExtension) await deleteRecord(state.context.videoId);
    state.record = null;
    state.selectedEntryId = null;
    elements.settingsDialog.close();
    render();
  });
  document.getElementById("clear-all").addEventListener("click", async () => {
    if (!confirm("確定清除全部本機歌單？此操作無法復原。")) return;
    if (isExtension) await clearAllRecords();
    state.record = null;
    state.selectedEntryId = null;
    elements.settingsDialog.close();
    render();
  });
}

function startDemoPlayback() {
  state.demoTimer = setInterval(() => {
    if (state.playback.paused || !selectedEntry()) return;
    state.playback.currentTime += 0.25;
    const end = calculateEntryEnd(state.record, state.selectedEntryId);
    const entry = selectedEntry();
    if (state.loopEnabled && end && state.playback.currentTime >= end) state.playback.currentTime = entry.startSeconds;
    renderPlayer();
  }, 250);
}

async function initialize() {
  bindEvents();
  if (!isExtension) {
    state.context = {
      videoId: "demo-video",
      videoTitle: "【歌枠】夜晚的歌回",
      channelName: "VTuber Music Channel",
      durationSeconds: 8027,
      thumbnailUrl: FALLBACK_THUMBNAIL,
      hasVideo: true,
      canLoop: true,
      isLive: false
    };
    state.record = buildRecord({ ...state.context, sources: [{ type: "comment", author: "@music_fan", rawText: DEMO_TIMELINE }] });
    const demoLastEntry = activeBlock()?.entries.at(-1);
    if (demoLastEntry) demoLastEntry.kind = "chapter";
    state.selectedEntryId = activeBlock()?.entries[1]?.id ?? null;
    state.playback = { currentTime: 637, paused: false };
    startDemoPlayback();
    render();
    return;
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "PAGE_CONTEXT_CHANGED") switchContext(message.context);
    if (message?.type === "PLAYBACK_STATE" && message.state.videoId === state.context?.videoId) {
      state.playback = message.state;
      renderPlayer();
    }
  });
  try {
    const response = await activeTabMessage({ type: "GET_CONTEXT" });
    await switchContext(response.context);
  } catch (error) {
    state.context = null;
    render();
    setStatus(error.message, "error");
  }
}

initialize();
