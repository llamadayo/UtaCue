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
  updateEntry
} from "./core.mjs";
import {
  clearAllRecords,
  deleteRecord,
  exportBackup,
  importBackup,
  loadRecord,
  saveRecord
} from "./storage.mjs";
import { extensionApi, isExtensionContext } from "./extension-api.mjs";
import { exportJsonBackup, readJsonBackup } from "./backup.mjs";

const isExtension = isExtensionContext;
const FALLBACK_THUMBNAIL = "fallback-thumbnail.png";
const DEMO_TIMELINE = `00:03:18 星のかけら
00:08:42 夜に駆ける
00:14:10 花のように
00:19:55 Blue Moon
00:25:30 MC / 雑談`;

const state = {
  tabId: null,
  connectionEpoch: 0,
  contextEpoch: 0,
  context: null,
  record: null,
  selectedEntryId: null,
  loopEnabled: true,
  showHidden: false,
  playback: { currentTime: 0, paused: true },
  pendingRecord: null,
  demoTimer: null,
  editSession: 0,
  playerBusy: false,
  notice: null
};

const elements = Object.fromEntries([
  "app", "video-thumbnail", "video-title", "video-channel", "video-duration",
  "source-picker", "source-trigger", "source-current", "source-options", "scan-button", "status-message", "show-hidden", "empty-state",
  "timeline", "player-panel", "playback-label", "now-title", "now-range", "loop-toggle", "progress",
  "progress-current", "progress-end", "play-button", "previous-button", "next-button",
  "paste-dialog", "paste-form", "paste-author", "paste-text", "paste-status", "edit-dialog", "edit-form",
  "edit-id", "edit-title", "edit-start", "edit-end", "edit-end-current", "edit-status", "edit-kind", "diff-dialog", "diff-form",
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

function setStatus(message, type = "neutral", { remember = true } = {}) {
  if (remember) state.notice = { message, type };
  elements.statusMessage.textContent = message;
  const row = elements.statusMessage.closest(".status-row");
  row.classList.toggle("success", type === "success");
  row.classList.toggle("error", type === "error");
}

async function activeTabMessage(message) {
  if (!isExtension) return demoMessage(message);
  if (state.tabId === null) {
    const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error("找不到目前分頁");
    state.tabId = tab.id;
  }
  const tabId = state.tabId;
  const expectedVideoId = message.type === "GET_CONTEXT" ? null : state.context?.videoId;
  const request = expectedVideoId ? { ...message, videoId: expectedVideoId } : message;
  let response;
  try {
    response = await extensionApi.tabs.sendMessage(tabId, request, { frameId: 0 });
  } catch {
    throw new Error("請在 Safari 或 Chrome 開啟 YouTube 影片，允許 UtaCue 存取此網站，再重新整理影片頁。");
  }
  if (tabId !== state.tabId || (expectedVideoId && expectedVideoId !== state.context?.videoId)) {
    throw new Error("目前影片已切換，請在新的歌單重新操作。");
  }
  if (!response?.ok) throw new Error(response?.error || "YouTube 頁面沒有回應");
  const responseVideoId = response.state?.videoId ?? response.context?.videoId;
  if (expectedVideoId && responseVideoId && responseVideoId !== expectedVideoId) {
    throw new Error("目前影片已切換，請重新開啟 UtaCue 後再試。");
  }
  return response;
}

function demoMessage(message) {
  if (message.type === "GET_CONTEXT") return { ok: true, context: state.context };
  if (message.type === "GET_PLAYBACK_STATE") {
    return { ok: true, state: { ...state.playback, videoId: state.context?.videoId,
      selectedEntryId: state.selectedEntryId, loop: state.playback.loop ?? null } };
  }
  if (message.type === "PLAYER_COMMAND") {
    if (message.command === "seek") state.playback.currentTime = Number(message.seconds) || 0;
    if (message.entryId) state.selectedEntryId = message.entryId;
    if (message.command === "seek" && Object.hasOwn(message, "loop")) state.playback.loop = message.loop;
    if (message.command === "seek" && message.play !== false) state.playback.paused = false;
    if (message.command === "toggle") state.playback.paused = !state.playback.paused;
    if (message.command === "play") state.playback.paused = false;
    if (message.command === "pause") state.playback.paused = true;
    renderPlayer();
    return { ok: true, state: { ...state.playback, videoId: state.context?.videoId, selectedEntryId: state.selectedEntryId } };
  }
  if (message.type === "SET_LOOP") {
    state.playback.loop = { ...message, videoId: state.context?.videoId };
  }
  if (message.type === "CLEAR_LOOP") {
    state.playback.loop = null;
    if (message.clearSelection) state.selectedEntryId = null;
  }
  if (message.type === "SCAN_PAGE") {
    return { ok: true, context: state.context, sources: [{ type: "comment", author: "@music_fan", rawText: DEMO_TIMELINE }] };
  }
  return { ok: true };
}

function sessionIdentity() {
  return { tabId: state.tabId, videoId: state.context?.videoId, epoch: state.contextEpoch };
}

function isCurrentSession(session) {
  return session.tabId === state.tabId && session.videoId === state.context?.videoId
    && session.epoch === state.contextEpoch;
}

async function reportTask(task) {
  try { await task(); }
  catch (error) { setStatus(error.message, "error"); }
}

async function clearSelectedPlayback() {
  if (state.playerBusy) throw new Error("播放操作進行中，請稍後再試。");
  if (state.context?.videoId) await activeTabMessage({ type: "CLEAR_LOOP", clearSelection: true });
  state.selectedEntryId = null;
  state.playback.loop = null;
}

function applyPlaybackState(playback, { restoreSelection = false } = {}) {
  if (!playback || playback.videoId !== state.context?.videoId) return;
  state.playback = playback;
  if (!state.playerBusy && (restoreSelection || Object.hasOwn(playback, "selectedEntryId"))) {
    const found = getEntry(state.record, playback.selectedEntryId);
    const previousSelection = state.selectedEntryId;
    state.selectedEntryId = found?.entry.id ?? null;
    if (found?.entry.kind === "song") state.loopEnabled = Boolean(playback.loop?.enabled);
    if (previousSelection !== state.selectedEntryId) renderTimeline();
  }
  renderPlayer();
}

async function restorePlayback() {
  const session = sessionIdentity();
  const response = await activeTabMessage({ type: "GET_PLAYBACK_STATE" });
  if (isCurrentSession(session)) applyPlaybackState(response.state, { restoreSelection: true });
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
  setSourceMenuOpen(false);
  elements.sourceOptions.replaceChildren();
  if (!state.record?.sources.length) {
    elements.sourceCurrent.textContent = "尚無來源";
    elements.sourceTrigger.disabled = true;
    elements.sourceTrigger.setAttribute("aria-label", "時間軸來源：尚無來源");
    return;
  }
  for (const source of state.record.sources) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "source-option";
    option.dataset.sourceId = source.id;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(source.id === state.record.activeSourceId));
    option.textContent = sourceLabel(source);
    elements.sourceOptions.append(option);
  }
  const current = activeSource() ?? state.record.sources[0];
  const label = sourceLabel(current);
  elements.sourceCurrent.textContent = label;
  elements.sourceTrigger.disabled = false;
  elements.sourceTrigger.setAttribute("aria-label", `時間軸來源：${label}`);
}

function setSourceMenuOpen(open, { focusActive = false } = {}) {
  const canOpen = Boolean(open && !elements.sourceTrigger.disabled);
  elements.sourceTrigger.setAttribute("aria-expanded", String(canOpen));
  elements.sourceOptions.hidden = !canOpen;
  if (canOpen && focusActive) {
    (elements.sourceOptions.querySelector('[aria-selected="true"]')
      ?? elements.sourceOptions.querySelector(".source-option"))?.focus();
  }
}

async function chooseSource(sourceId) {
  if (!state.record?.sources.some((source) => source.id === sourceId)) return;
  if (sourceId === state.record.activeSourceId) return;
  await clearSelectedPlayback();
  state.record.activeSourceId = sourceId;
  state.record.activeBlockId = selectBestBlock(state.record.blocks.filter((block) => block.sourceId === sourceId))?.id ?? null;
  state.selectedEntryId = null;
  setSourceMenuOpen(false);
  await persist(state.record);
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
  main.disabled = state.playerBusy;
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
  elements.playbackLabel.textContent = state.playback.paused ? "目前選曲 · 已暫停" : "播放中";
  elements.nowRange.textContent = `${formatTimestamp(entry.startSeconds)} — ${formatTimestamp(end)}`;
  elements.loopToggle.checked = state.loopEnabled;
  elements.loopToggle.disabled = state.playerBusy || !end || !state.context?.canLoop;
  elements.playButton.classList.toggle("paused", state.playback.paused);
  elements.playButton.setAttribute("aria-label", state.playback.paused ? "播放" : "暫停");
  elements.playButton.disabled = state.playerBusy;
  elements.previousButton.disabled = state.playerBusy;
  elements.nextButton.disabled = state.playerBusy;
  elements.progress.disabled = state.playerBusy || !end;
  const current = Math.max(entry.startSeconds, state.playback.currentTime || entry.startSeconds);
  const range = end ? end - entry.startSeconds : 0;
  const position = range > 0 ? Math.min(1, Math.max(0, (current - entry.startSeconds) / range)) : 0;
  elements.progress.value = Math.round(position * 1000);
  elements.progressCurrent.textContent = formatTimestamp(current);
  elements.progressEnd.textContent = formatTimestamp(end);
}

function renderStatus() {
  if (state.notice) {
    setStatus(state.notice.message, state.notice.type, { remember: false });
    return;
  }
  if (!state.context?.videoId) {
    setStatus("請先開啟一部 YouTube 影片", "error", { remember: false });
    return;
  }
  if (!state.record) {
    setStatus("尚未建立歌單", "neutral", { remember: false });
    return;
  }
  const count = visibleSongCount();
  setStatus(`已找到 ${count} 首・更新於 ${relativeUpdatedAt(state.record.updatedAt)}`, "success", { remember: false });
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
  const session = sessionIdentity();
  if (isExtension) await saveRecord(record);
  if (!isCurrentSession(session)) return;
  state.record = record;
  state.notice = null;
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
  const epoch = ++state.contextEpoch;
  state.editSession += 1;
  state.pendingRecord = null;
  state.playerBusy = false;
  state.notice = null;
  for (const dialog of [elements.editDialog, elements.pasteDialog, elements.diffDialog]) {
    if (dialog.open) dialog.close();
  }
  state.selectedEntryId = null;
  state.loopEnabled = true;
  state.playback = { currentTime: 0, paused: true };
  state.record = null;
  render();
  const record = context?.videoId && isExtension ? await loadRecord(context.videoId) : null;
  if (epoch !== state.contextEpoch) return;
  state.record = record;
  if (record && Number.isFinite(context?.durationSeconds)) record.durationSeconds = context.durationSeconds;
  render();
  if (context?.videoId && context?.hasVideo !== false) {
    // The page owns the session; opening a popup must never reset its loop.
    try { await restorePlayback(); } catch { /* A loading player can report its state later. */ }
  }
}

async function scanPage() {
  if (!state.context?.videoId) {
    setStatus("請先開啟一部 YouTube 影片", "error");
    return;
  }
  if (elements.scanButton.disabled) return;
  const session = sessionIdentity();
  setStatus("正在掃描已載入的說明欄與留言…");
  elements.scanButton.disabled = true;
  try {
    const response = await activeTabMessage({ type: "SCAN_PAGE" });
    if (!isCurrentSession(session)) return;
    if (response.context?.videoId !== session.videoId) throw new Error("目前影片已切換，請重新開啟 UtaCue 後再掃描。");
    state.context = response.context;
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
    state.notice = null;
    renderStatus();
    elements.diffDialog.showModal();
  } catch (error) {
    if (isCurrentSession(session)) setStatus(error.message, "error");
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
  await clearSelectedPlayback();
  await persist(merged);
}

async function selectEntry(entryId) {
  if (state.playerBusy) return;
  const found = getEntry(state.record, entryId);
  if (!found) return;
  const session = sessionIdentity();
  const wantsLoop = state.loopEnabled;
  const end = calculateEntryEnd(state.record, entryId);
  state.playerBusy = true;
  state.notice = null;
  render();
  try {
    const loop = found.entry.kind === "song" && wantsLoop && end && state.context?.canLoop
      ? { enabled: true, startSeconds: found.entry.startSeconds, endSeconds: end, entryId, videoId: session.videoId }
      : null;
    // Set the selection and loop in one page-owned command. A popup may close
    // while play() is buffering, so no essential step may depend on its reply.
    const response = await activeTabMessage({ type: "PLAYER_COMMAND", command: "seek",
      seconds: found.entry.startSeconds, play: true, entryId, loop });
    if (!isCurrentSession(session)) return;
    state.selectedEntryId = entryId;
    if (response.state) state.playback = response.state;
    if (response.playbackBlocked) setStatus(response.message || "已跳到歌曲，請在影片上點一下播放。", "error");
  } catch (error) {
    if (isCurrentSession(session)) setStatus(error.message, "error");
  } finally {
    if (isCurrentSession(session)) {
      state.playerBusy = false;
      try { await restorePlayback(); } catch { /* Keep the original action error visible. */ }
      render();
    }
  }
}

async function updateLoop() {
  const entry = selectedEntry();
  const end = entry ? calculateEntryEnd(state.record, entry.id) : null;
  if (entry?.kind === "song" && state.loopEnabled && end && state.context?.canLoop) {
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
  state.editSession += 1;
  elements.editEndCurrent.disabled = false;
  setEditStatus("");
  elements.editId.value = entry.id;
  elements.editTitle.value = entry.title;
  elements.editStart.value = formatTimestamp(entry.startSeconds, { padHours: entry.startSeconds >= 3600 });
  elements.editEnd.value = Number.isFinite(entry.endSeconds)
    ? formatTimestamp(entry.endSeconds, { padHours: entry.endSeconds >= 3600 }) : "";
  elements.editKind.querySelectorAll('input[name="edit-kind"]').forEach((input) => {
    input.checked = input.value === entry.kind;
  });
  elements.editDialog.showModal();
}

function setEditStatus(message, type = "neutral") {
  elements.editStatus.textContent = message;
  elements.editStatus.hidden = !message;
  elements.editStatus.classList.toggle("error", type === "error");
}

async function captureEndTime() {
  const session = state.editSession;
  const videoId = state.record?.videoId;
  const isCurrentEdit = () => elements.editDialog.open
    && state.editSession === session && state.record?.videoId === videoId;
  elements.editEndCurrent.disabled = true;
  setEditStatus("正在取得播放時間…");
  try {
    const response = await activeTabMessage({ type: "GET_PLAYBACK_STATE" });
    if (!isCurrentEdit()) return;
    if (!videoId || response.state?.videoId !== videoId) {
      throw new Error("目前分頁的影片與編輯中的時間軸不同，請切回原影片");
    }
    const currentTime = response.state.currentTime;
    if (!Number.isFinite(currentTime) || currentTime < 0) {
      throw new Error("目前無法取得播放時間，請稍後再試");
    }
    const startSeconds = parseTimestamp(elements.editStart.value.trim());
    if (startSeconds === null) throw new Error("開始時間格式不正確");
    const endSeconds = Math.floor(currentTime);
    if (endSeconds <= startSeconds) throw new Error("目前播放時間必須晚於開始時間");
    elements.editEnd.value = formatTimestamp(endSeconds, { padHours: endSeconds >= 3600 });
    setEditStatus(`已填入 ${elements.editEnd.value}，儲存變更後套用。`);
  } catch (error) {
    if (isCurrentEdit()) setEditStatus(error.message, "error");
  } finally {
    if (isCurrentEdit()) elements.editEndCurrent.disabled = false;
  }
}

async function saveEdit() {
  if (state.playerBusy) throw new Error("播放操作進行中，請稍後再試。");
  const session = sessionIdentity();
  const startSeconds = parseTimestamp(elements.editStart.value.trim());
  const endValue = elements.editEnd.value.trim();
  const endSeconds = endValue ? parseTimestamp(endValue) : null;
  const kind = elements.editKind.querySelector('input[name="edit-kind"]:checked')?.value;
  if (!elements.editTitle.value.trim()) throw new Error("請輸入標題");
  if (startSeconds === null) throw new Error("開始時間格式不正確");
  if (endValue && (endSeconds === null || endSeconds <= startSeconds)) throw new Error("結束時間必須晚於開始時間");
  const duration = state.context?.durationSeconds ?? state.record?.durationSeconds;
  if (Number.isFinite(duration) && (startSeconds >= duration || (endSeconds !== null && endSeconds > duration))) {
    throw new Error("開始與結束時間必須在這部影片的長度內。");
  }
  if (!kind) throw new Error("請選擇項目類型");
  const updated = updateEntry(state.record, elements.editId.value, {
    title: elements.editTitle.value.trim(),
    startSeconds,
    endSeconds,
    kind
  });
  await persist(updated);
  if (isCurrentSession(session) && state.selectedEntryId) await updateLoop();
}

async function backupPayload(currentOnly) {
  if (isExtension) return exportBackup(currentOnly ? state.context?.videoId : null);
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), records: state.record ? [state.record] : [] };
}

function openDialog(dialog) {
  if (dialog === elements.pasteDialog) {
    elements.pasteStatus.textContent = "";
    elements.pasteStatus.hidden = true;
  }
  if (dialog === elements.settingsDialog) {
    document.getElementById("export-current").disabled = !state.context?.videoId;
    document.getElementById("clear-current").disabled = !state.context?.videoId;
  }
  if (!dialog.open) dialog.showModal();
}

async function exportBackupFile(currentOnly) {
  const button = document.getElementById(currentOnly ? "export-current" : "export-all");
  button.disabled = true;
  try {
    const videoId = state.context?.videoId;
    if (currentOnly && !videoId) throw new Error("請先開啟一部 YouTube 影片");
    const payload = await backupPayload(currentOnly);
    const result = await exportJsonBackup(payload, currentOnly ? `UtaCue-${videoId}.json` : "UtaCue-backup.json");
    elements.settingsStatus.textContent = result.method === "cancelled" ? "已取消匯出。"
      : result.method === "share" ? `已分享 ${payload.records.length} 份歌單。`
        : `已匯出 ${payload.records.length} 份歌單，請查看下載項目。`;
  } catch (error) {
    elements.settingsStatus.textContent = `匯出失敗：${error.message}`;
  } finally {
    button.disabled = currentOnly && !state.context?.videoId;
  }
}

async function applyImportedBackup(payload) {
  const session = sessionIdentity();
  const importedCurrent = payload.records.find((record) => record.videoId === session.videoId);
  if (importedCurrent) await clearSelectedPlayback();
  if (isExtension) await importBackup(payload);
  if (!isCurrentSession(session)) return;
  if (importedCurrent) {
    state.record = importedCurrent;
    if (Number.isFinite(state.context?.durationSeconds)) state.record.durationSeconds = state.context.durationSeconds;
  }
  state.notice = null;
  render();
}

async function applyPendingScan() {
  if (!state.pendingRecord) return;
  const incoming = state.pendingRecord;
  // Rescanning may change entry IDs or the next boundary. Stop the previous
  // page-owned loop before replacing the data it was calculated from.
  await clearSelectedPlayback();
  await persist(incoming);
  state.pendingRecord = null;
  elements.diffDialog.close();
}

async function playerCommand(message) {
  state.notice = null;
  const response = await activeTabMessage({ type: "PLAYER_COMMAND", ...message });
  if (response.state) applyPlaybackState(response.state);
  if (response.playbackBlocked) setStatus(response.message || "請在影片上點一下播放。", "error");
}

function bindEvents() {
  document.getElementById("header-settings").addEventListener("click", () => openDialog(elements.settingsDialog));
  document.getElementById("footer-settings").addEventListener("click", () => openDialog(elements.settingsDialog));
  document.getElementById("paste-open").addEventListener("click", () => openDialog(elements.pasteDialog));
  document.getElementById("empty-paste").addEventListener("click", () => openDialog(elements.pasteDialog));
  document.getElementById("empty-scan").addEventListener("click", scanPage);
  document.getElementById("footer-scan").addEventListener("click", scanPage);
  elements.scanButton.addEventListener("click", scanPage);
  elements.videoThumbnail.addEventListener("error", () => {
    if (!elements.videoThumbnail.src.endsWith(FALLBACK_THUMBNAIL)) elements.videoThumbnail.src = FALLBACK_THUMBNAIL;
  });

  elements.sourceTrigger.addEventListener("click", () => {
    const willOpen = elements.sourceTrigger.getAttribute("aria-expanded") !== "true";
    setSourceMenuOpen(willOpen, { focusActive: willOpen });
  });
  elements.sourceOptions.addEventListener("click", async (event) => {
    const option = event.target.closest("[data-source-id]");
    if (option) {
      await reportTask(() => chooseSource(option.dataset.sourceId));
      elements.sourceTrigger.focus();
    }
  });
  elements.sourceOptions.addEventListener("keydown", async (event) => {
    const options = [...elements.sourceOptions.querySelectorAll(".source-option")];
    const index = options.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setSourceMenuOpen(false);
      elements.sourceTrigger.focus();
      return;
    }
    const nextIndex = event.key === "ArrowDown" ? Math.min(options.length - 1, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? options.length - 1 : null;
    if (nextIndex !== null && options[nextIndex]) {
      event.preventDefault();
      options[nextIndex].focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!elements.sourcePicker.contains(event.target)) setSourceMenuOpen(false);
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
      await reportTask(async () => {
        await clearSelectedPlayback();
        state.record.activeBlockId = action.dataset.blockId;
        await persist(state.record);
      });
    }
  });

  elements.loopToggle.addEventListener("change", async () => {
    const session = sessionIdentity();
    state.loopEnabled = elements.loopToggle.checked;
    state.playerBusy = true;
    state.notice = null;
    renderPlayer();
    try { await updateLoop(); }
    catch (error) { if (isCurrentSession(session)) setStatus(error.message, "error"); }
    finally {
      if (isCurrentSession(session)) {
        state.playerBusy = false;
        try { await restorePlayback(); } catch { /* Retain the original error. */ }
        renderPlayer();
      }
    }
  });
  elements.playButton.addEventListener("click", () => reportTask(() => playerCommand({ command: "toggle" })));
  elements.previousButton.addEventListener("click", () => reportTask(() => moveSong(-1)));
  elements.nextButton.addEventListener("click", () => reportTask(() => moveSong(1)));
  elements.progress.addEventListener("input", async () => {
    const entry = selectedEntry();
    const end = entry ? calculateEntryEnd(state.record, entry.id) : null;
    if (!entry || !end) return;
    const seconds = entry.startSeconds + (end - entry.startSeconds) * (Number(elements.progress.value) / 1000);
    state.playback.currentTime = seconds;
    renderPlayer();
    try { await playerCommand({ command: "seek", seconds, play: false }); }
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
      elements.pasteStatus.textContent = error.message;
      elements.pasteStatus.hidden = false;
    }
  });
  elements.editEndCurrent.addEventListener("click", captureEndTime);
  elements.editForm.addEventListener("submit", async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    try { await saveEdit(); elements.editDialog.close(); }
    catch (error) { setEditStatus(error.message, "error"); }
  });
  elements.diffForm.addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "cancel" && state.pendingRecord) {
      event.preventDefault();
      await reportTask(applyPendingScan);
    } else state.pendingRecord = null;
  });

  document.getElementById("export-current").addEventListener("click", () => exportBackupFile(true));
  document.getElementById("export-all").addEventListener("click", () => exportBackupFile(false));
  elements.importFile.addEventListener("change", async () => {
    const file = elements.importFile.files?.[0];
    if (!file) return;
    try {
      const payload = await readJsonBackup(file);
      const confirmed = confirm(`即將匯入 ${payload.records.length} 份歌單；相同影片會以匯入資料取代。是否繼續？`);
      if (!confirmed) return;
      await applyImportedBackup(payload);
      elements.settingsStatus.textContent = `已匯入 ${payload.records.length} 份歌單。`;
    } catch (error) {
      elements.settingsStatus.textContent = `匯入失敗：${error.message}`;
    } finally {
      elements.importFile.value = "";
    }
  });
  document.getElementById("clear-current").addEventListener("click", async () => {
    if (!state.context?.videoId || !confirm("確定清除目前影片的歌單？此操作無法復原。")) return;
    try {
      const session = sessionIdentity();
      await clearSelectedPlayback();
      if (isExtension) await deleteRecord(session.videoId);
      if (!isCurrentSession(session)) return;
      state.record = null;
      state.notice = null;
      elements.settingsDialog.close();
      render();
    } catch (error) { elements.settingsStatus.textContent = `清除失敗：${error.message}`; }
  });
  document.getElementById("clear-all").addEventListener("click", async () => {
    if (!confirm("確定清除全部本機歌單？此操作無法復原。")) return;
    try {
      const session = sessionIdentity();
      await clearSelectedPlayback();
      if (isExtension) await clearAllRecords();
      if (!isCurrentSession(session)) return;
      state.record = null;
      state.notice = null;
      elements.settingsDialog.close();
      render();
    } catch (error) { elements.settingsStatus.textContent = `清除失敗：${error.message}`; }
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

async function connectActiveTab() {
  const epoch = ++state.connectionEpoch;
  try {
    const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
    if (epoch !== state.connectionEpoch) return;
    if (!Number.isInteger(tab?.id)) throw new Error("找不到目前分頁");
    if (state.tabId !== tab.id) {
      state.tabId = tab.id;
      await switchContext(null);
    }
    const response = await activeTabMessage({ type: "GET_CONTEXT" });
    if (epoch !== state.connectionEpoch) return;
    const sameVideo = response.context?.videoId === state.context?.videoId;
    await switchContext(response.context);
    if (sameVideo && response.context?.videoId) await restorePlayback();
  } catch (error) {
    if (epoch !== state.connectionEpoch) return;
    await switchContext(null);
    setStatus(error.message, "error");
  }
}

function handleRuntimeMessage(message, sender) {
  // Runtime messages can originate from every YouTube tab. Only the tab this
  // popup is attached to may replace its song list or playback state.
  if (sender?.tab?.id !== state.tabId || (sender.frameId !== undefined && sender.frameId !== 0)) return;
  if (message?.type === "PAGE_CONTEXT_CHANGED") {
    reportTask(() => switchContext(message.context));
  }
  if (message?.type === "PLAYBACK_STATE") applyPlaybackState(message.state);
}

function updateVisualViewport() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty("--visible-height", `${viewport?.height ?? window.innerHeight}px`);
  document.documentElement.style.setProperty("--visible-top", `${viewport?.offsetTop ?? 0}px`);
}

async function initialize() {
  bindEvents();
  updateVisualViewport();
  window.visualViewport?.addEventListener("resize", updateVisualViewport);
  window.visualViewport?.addEventListener("scroll", updateVisualViewport);
  window.addEventListener("resize", updateVisualViewport);
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
  extensionApi.runtime.onMessage.addListener(handleRuntimeMessage);
  extensionApi.tabs.onActivated?.addListener(() => { connectActiveTab(); });
  extensionApi.tabs.onRemoved?.addListener((tabId) => {
    if (tabId === state.tabId) connectActiveTab();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) connectActiveTab();
  });
  await connectActiveTab();
}

initialize().catch((error) => setStatus(error.message, "error"));
