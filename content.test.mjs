import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const contentSource = await readFile(new URL("./content.js", import.meta.url), "utf8");

function eventTarget() {
  const callbacks = new Map();
  return {
    addEventListener(name, callback) {
      if (!callbacks.has(name)) callbacks.set(name, new Set());
      callbacks.get(name).add(callback);
    },
    removeEventListener(name, callback) { callbacks.get(name)?.delete(callback); },
    dispatch(name) {
      for (const callback of callbacks.get(name) || []) callback({ currentTarget: this });
    }
  };
}

function makeVideo(overrides = {}) {
  let time = 0;
  const video = {
    ...eventTarget(), duration: 7200, paused: true, ended: false, readyState: 4,
    currentSrc: "media-a", playCalls: 0, pauseCalls: 0,
    get currentTime() { return time; },
    set currentTime(value) { time = value; if (value < this.duration) this.ended = false; },
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
    pause() { this.pauseCalls += 1; this.paused = true; }
  };
  return Object.assign(video, overrides);
}

function node(text) { return { innerText: text, textContent: text }; }

function comment(text, author, mobile = false) {
  return {
    querySelector(selector) {
      if (selector === (mobile ? ".comment-text" : "#content-text")) return node(text);
      if (selector === (mobile ? ".comment-title" : "#author-text")) return node(author);
      return null;
    }
  };
}

function harness(options = {}) {
  let listener;
  let intervalCallback;
  let now = 1000;
  const messages = [];
  const location = { href: options.url || "https://www.youtube.com/watch?v=video-a" };
  const page = {
    title: "Video A - YouTube", videoTitle: "Video A", channelName: "Channel A",
    metaThumbnail: "https://i.ytimg.com/vi/video-a/old-meta.jpg",
    video: Object.hasOwn(options, "video") ? options.video : makeVideo(),
    isAd: false, declaredVideoId: null, nodes: new Map(), comments: [], closedPopup: false
  };
  const document = {
    ...eventTarget(), hidden: false,
    get title() { return page.title; },
    querySelector(selector) {
      if (page.nodes.has(selector)) return page.nodes.get(selector);
      if (selector.startsWith("video.html5-main-video") || selector === "video") return page.video;
      if (selector.includes(".ad-showing")) return page.isAd ? {} : null;
      if (selector === "ytd-watch-flexy[video-id], ytm-watch[video-id]") {
        return page.declaredVideoId ? { getAttribute: () => page.declaredVideoId } : null;
      }
      if (selector === "ytd-watch-metadata h1 yt-formatted-string" && !options.mobile) return node(page.videoTitle);
      if (selector === "ytd-watch-metadata ytd-channel-name a" && !options.mobile) return node(page.channelName);
      if (selector === "ytm-slim-video-metadata-renderer .slim-video-metadata-title" && options.mobile) return node(page.videoTitle);
      if (selector === "ytm-slim-owner-renderer .slim-owner-channel-name" && options.mobile) return node(page.channelName);
      if (selector === 'meta[property="og:image"]') return { content: page.metaThumbnail };
      return null;
    },
    querySelectorAll(selector) { return selector.includes("comment-") ? page.comments : []; }
  };
  const runtime = {
    sendMessage(message) {
      messages.push(message);
      if (page.closedPopup) return Promise.reject(new Error("No receiving end"));
      return Promise.resolve();
    },
    onMessage: { addListener(callback) { listener = callback; } }
  };
  const window = eventTarget();
  vm.runInNewContext(contentSource, {
    URL, location, document, window,
    [options.browser ? "browser" : "chrome"]: { runtime },
    performance: { now: () => now },
    setInterval(callback) { intervalCallback = callback; }
  });
  const dispatch = (message) => {
    let resolve;
    const response = new Promise((done) => { resolve = done; });
    const keepAlive = listener(message, {}, resolve);
    return { response, keepAlive };
  };
  return {
    page, document, window, location, messages, dispatch,
    send: (message) => dispatch(message).response,
    state: () => dispatch({ type: "GET_PLAYBACK_STATE" }).response,
    tick() { now += 500; intervalCallback(); }
  };
}

const loopMessage = (overrides = {}) => ({
  type: "SET_LOOP", videoId: "video-a", enabled: true,
  startSeconds: 10, endSeconds: 20, entryId: "song-a", ...overrides
});

test("reads fresh player time on demand without seeking or changing playback", async () => {
  const video = makeVideo({ currentTime: 637.9 });
  const h = harness({ video });
  let response = await h.state();
  assert.equal(response.ok, true);
  assert.equal(response.state.currentTime, 637.9);
  assert.equal(response.state.videoId, "video-a");
  assert.equal(response.state.paused, true);
  assert.equal(response.state.loop, null);
  assert.equal(response.state.selectedEntryId, null);
  video.currentTime = 3723.4;
  response = await h.state();
  assert.equal(response.state.currentTime, 3723.4);
  assert.equal(video.currentTime, 3723.4);
  assert.equal(video.paused, true);
  assert.equal(video.playCalls, 0);
});

test("reports unavailable players and invalid playback times", async () => {
  for (const video of [null, makeVideo({ currentTime: NaN }), makeVideo({ currentTime: Infinity }), makeVideo({ currentTime: -1 })]) {
    const response = await harness({ video }).state();
    assert.equal(response.ok, false);
    assert.match(response.error, /播放器|播放時間/);
  }
});

test("broadcasts refreshed metadata after a YouTube SPA video switch", async () => {
  const h = harness();
  const contexts = () => h.messages.filter((message) => message.type === "PAGE_CONTEXT_CHANGED");
  assert.equal(contexts().length, 1);
  h.location.href = "https://www.youtube.com/watch?v=video-b";
  h.tick();
  assert.equal(contexts().length, 2);
  assert.equal(contexts().at(-1).context.videoId, "video-b");
  assert.equal(contexts().at(-1).context.videoTitle, "Video A");
  assert.equal(contexts().at(-1).context.thumbnailUrl, "https://i.ytimg.com/vi/video-b/hqdefault.jpg");
  h.page.title = "Video B - YouTube";
  h.page.videoTitle = "Video B";
  h.page.channelName = "Channel B";
  h.tick();
  assert.equal(contexts().length, 3);
  assert.equal(contexts().at(-1).context.videoTitle, "Video B");
  assert.equal(contexts().at(-1).context.channelName, "Channel B");
  h.tick();
  assert.equal(contexts().length, 3);
});

test("scans mobile descriptions and loaded comments while preserving timestamp lines", async () => {
  const h = harness({ mobile: true, url: "https://m.youtube.com/watch?v=video-a" });
  const description = "Setlist\n00:10 First song\n01:20 Second song";
  h.page.nodes.set("ytm-expandable-video-description-body-renderer", node(description));
  h.page.comments = [comment("00:10 First song\n01:20 Second song", "@fan", true), comment("00:10 First song\n01:20 Second song", "@fan", true)];
  const response = await h.send({ type: "SCAN_PAGE" });
  assert.equal(response.ok, true);
  assert.equal(response.context.videoTitle, "Video A");
  assert.equal(response.context.channelName, "Channel A");
  assert.equal(response.sources.length, 2);
  assert.equal(response.sources[0].type, "description");
  assert.equal(response.sources[0].rawText, description);
  assert.equal(response.sources[1].type, "comment");
  assert.equal(response.sources[1].author, "@fan");
  assert.equal(response.sources[1].rawText, "00:10 First song\n01:20 Second song");
  assert.equal(h.page.video.playCalls, 0);
});

test("preserves desktop description/comment scanning and meta title fallback", async () => {
  const h = harness();
  h.page.videoTitle = "";
  h.page.nodes.set('meta[property="og:title"]', { content: "Metadata title" });
  h.page.nodes.set("ytd-watch-metadata #description-inline-expander", node("0:00 Opening\n1:00 Song"));
  h.page.comments = [comment("1:00 Song", "@desktop")];
  const response = await h.send({ type: "SCAN_PAGE" });
  assert.equal(response.context.videoTitle, "Metadata title");
  assert.equal(response.sources.length, 2);
  assert.equal(response.sources[1].author, "@desktop");
});

test("supports browser.runtime and keeps asynchronous playback response channels open", async () => {
  const h = harness({ browser: true });
  const request = h.dispatch({ type: "PLAYER_COMMAND", command: "seek", seconds: 12, entryId: "song-a", videoId: "video-a" });
  assert.equal(request.keepAlive, true);
  const response = await request.response;
  assert.equal(response.ok, true);
  assert.equal(response.state.paused, false);
  assert.equal(response.state.selectedEntryId, "song-a");
});

test("validates finite loop ranges, duration, live media, and video identity", async () => {
  const h = harness({ video: makeVideo({ duration: 60 }) });
  const invalid = [
    { startSeconds: NaN }, { startSeconds: -1 }, { startSeconds: "" }, { startSeconds: null },
    { endSeconds: Infinity }, { endSeconds: 10 }, { endSeconds: 9 }, { endSeconds: 61 }, { videoId: "video-b" }
  ];
  for (const override of invalid) {
    const response = await h.send(loopMessage(override));
    assert.equal(response.ok, false, JSON.stringify(override));
    assert.equal((await h.state()).state.loop, null);
  }
  assert.equal((await h.send(loopMessage({ endSeconds: 60 }))).ok, true);
  h.page.video.duration = Infinity;
  assert.equal((await h.send(loopMessage())).ok, false);
});

test("page-owned looping survives popup closure and exposes restorable state", async () => {
  const h = harness({ video: makeVideo({ paused: false }) });
  assert.equal((await h.send(loopMessage())).ok, true);
  h.page.closedPopup = true;
  h.page.video.currentTime = 20.2;
  h.tick();
  assert.equal(h.page.video.currentTime, 10);
  h.page.closedPopup = false;
  const response = await h.state();
  assert.equal(response.state.loop.videoId, "video-a");
  assert.equal(response.state.loop.entryId, "song-a");
  assert.equal(response.state.loop.startSeconds, 10);
  assert.equal(response.state.selectedEntryId, "song-a");
  assert.equal(response.state.paused, false);
});

test("clearing a loop preserves selection unless clearSelection is requested", async () => {
  const h = harness();
  await h.send(loopMessage());
  let response = await h.send({ type: "CLEAR_LOOP", videoId: "video-a" });
  assert.equal(response.state.loop, null);
  assert.equal(response.state.selectedEntryId, "song-a");
  response = await h.send({ type: "CLEAR_LOOP", clearSelection: true, videoId: "video-a" });
  assert.equal(response.state.selectedEntryId, null);
});

test("new song seek removes the previous loop before asynchronous play resolves", async () => {
  const h = harness({ video: makeVideo({ paused: false }) });
  await h.send(loopMessage());
  let finishPlay;
  h.page.video.play = () => new Promise((resolve) => { finishPlay = resolve; });
  const request = h.dispatch({ type: "PLAYER_COMMAND", command: "seek", seconds: 35, entryId: "song-b", videoId: "video-a" });
  h.tick();
  assert.equal(h.page.video.currentTime, 35);
  assert.equal((await h.state()).state.loop, null);
  assert.equal((await h.state()).state.selectedEntryId, "song-b");
  finishPlay();
  assert.equal((await request.response).ok, true);
  assert.equal((await h.send(loopMessage({ startSeconds: 35, endSeconds: 50, entryId: "song-b" }))).ok, true);
});

test("atomic song selection keeps its new loop when the popup closes during pending play", async () => {
  const h = harness();
  await h.send(loopMessage());
  let finishPlay;
  h.page.video.play = () => new Promise((resolve) => { finishPlay = resolve; });
  const request = h.dispatch({
    type: "PLAYER_COMMAND", command: "seek", seconds: 35, entryId: "song-b", videoId: "video-a",
    loop: { enabled: true, startSeconds: 35, endSeconds: 50, entryId: "song-b", videoId: "video-a" }
  });
  h.page.closedPopup = true;
  let snapshot = (await h.state()).state;
  assert.equal(snapshot.selectedEntryId, "song-b");
  assert.equal(snapshot.loop.startSeconds, 35);
  assert.equal(snapshot.loop.endSeconds, 50);
  h.page.video.paused = false;
  h.page.video.currentTime = 50.2;
  h.tick();
  assert.equal(h.page.video.currentTime, 35);
  finishPlay();
  assert.equal((await request.response).ok, true);
  h.page.closedPopup = false;
  snapshot = (await h.state()).state;
  assert.equal(snapshot.loop.entryId, "song-b");
});

test("invalid atomic song loops do not seek or replace the previous selection", async () => {
  const h = harness();
  await h.send(loopMessage());
  h.page.video.currentTime = 14;
  for (const loop of [
    { enabled: true, startSeconds: 35, endSeconds: 30 },
    { enabled: true, startSeconds: 35, endSeconds: Infinity },
    { enabled: true, startSeconds: 35, endSeconds: 50, videoId: "video-b" },
    { enabled: true, startSeconds: 35, endSeconds: 50, entryId: "another-song" },
    { enabled: false }, "invalid"
  ]) {
    const response = await h.send({ type: "PLAYER_COMMAND", command: "seek", seconds: 35, entryId: "song-b", videoId: "video-a", loop });
    assert.equal(response.ok, false);
    assert.equal(h.page.video.currentTime, 14);
    assert.equal(h.page.video.playCalls, 0);
    assert.equal((await h.state()).state.selectedEntryId, "song-a");
    assert.equal((await h.state()).state.loop.entryId, "song-a");
  }
});

test("pending atomic play cannot restore a cleared loop or overwrite a newer song", async () => {
  for (const action of ["clear", "select"]) {
    const h = harness();
    let finishPlay;
    h.page.video.play = () => new Promise((resolve) => { finishPlay = resolve; });
    const request = h.dispatch({
      type: "PLAYER_COMMAND", command: "seek", seconds: 10, entryId: "song-a", videoId: "video-a",
      loop: { enabled: true, startSeconds: 10, endSeconds: 20 }
    });
    if (action === "clear") await h.send({ type: "CLEAR_LOOP", clearSelection: true });
    else await h.send({ type: "PLAYER_COMMAND", command: "seek", seconds: 35, entryId: "song-b", play: false, loop: null });
    finishPlay();
    await request.response;
    const snapshot = (await h.state()).state;
    assert.equal(snapshot.loop, null);
    assert.equal(snapshot.selectedEntryId, action === "clear" ? null : "song-b");
    assert.equal(snapshot.currentTime, action === "clear" ? 10 : 35);
  }
});

test("reports Safari user-gesture blocking truthfully and still permits loop setup", async () => {
  const h = harness();
  h.page.video.play = () => Promise.reject(Object.assign(new Error("Gesture required"), { name: "NotAllowedError" }));
  const response = await h.send({ type: "PLAYER_COMMAND", command: "seek", seconds: 10, entryId: "song-a", videoId: "video-a" });
  assert.equal(response.ok, true);
  assert.equal(response.playbackBlocked, true);
  assert.equal(response.state.paused, true);
  assert.equal(response.state.currentTime, 10);
  assert.match(response.message, /點.*影片播放/);
  assert.equal((await h.send(loopMessage())).ok, true);
  assert.equal((await h.state()).state.paused, true);
});

test("manual timeline seeks keep the current selection and loop", async () => {
  const h = harness();
  await h.send(loopMessage());
  const response = await h.send({ type: "PLAYER_COMMAND", command: "seek", seconds: 15, play: false, videoId: "video-a" });
  assert.equal(response.ok, true);
  assert.equal(response.state.currentTime, 15);
  assert.equal(response.state.selectedEntryId, "song-a");
  assert.equal(response.state.loop.entryId, "song-a");
  assert.equal(response.state.paused, true);
});

test("returns other player failures instead of claiming successful playback", async () => {
  const h = harness();
  h.page.video.play = () => Promise.reject(new Error("Media unavailable"));
  const response = await h.send({ type: "PLAYER_COMMAND", command: "play", videoId: "video-a" });
  assert.equal(response.ok, false);
  assert.match(response.error, /Media unavailable/);
  assert.equal(response.state.paused, true);
});

test("rejects commands for another video without changing the active loop", async () => {
  const h = harness();
  await h.send(loopMessage());
  const response = await h.send({ type: "PLAYER_COMMAND", command: "seek", seconds: 35, entryId: "song-b", videoId: "video-b" });
  assert.equal(response.ok, false);
  assert.equal(h.page.video.currentTime, 0);
  assert.equal((await h.state()).state.loop.entryId, "song-a");
  assert.equal((await h.send({ type: "CLEAR_LOOP", videoId: "video-b" })).ok, false);
  assert.equal((await h.state()).state.selectedEntryId, "song-a");
});

test("SPA navigation invalidates old loops before timers and waits for replacement media", async () => {
  const h = harness({ video: makeVideo({ paused: false }) });
  await h.send(loopMessage());
  h.location.href = "https://m.youtube.com/watch?v=video-b";
  h.page.video.currentTime = 25;
  assert.equal((await h.send(loopMessage())).ok, false);
  assert.equal((await h.send(loopMessage({ videoId: "video-b" }))).ok, false);
  assert.equal((await h.send({ type: "SCAN_PAGE" })).ok, false);
  h.tick();
  assert.equal(h.page.video.currentTime, 25);
  h.page.video.currentSrc = "media-b";
  h.page.video.dispatch("loadedmetadata");
  const response = await h.state();
  assert.equal(response.ok, true);
  assert.equal(response.state.videoId, "video-b");
  assert.equal(response.state.loop, null);
  assert.equal(response.state.selectedEntryId, null);
  assert.equal((await h.send(loopMessage({ videoId: "video-b" }))).ok, true);
});

test("ad playback cannot be scanned as duration or controlled by the content loop", async () => {
  const h = harness({ video: makeVideo({ paused: false }) });
  await h.send(loopMessage());
  h.page.isAd = true;
  h.page.video.duration = 30;
  h.page.video.currentTime = 24;
  h.tick();
  assert.equal(h.page.video.currentTime, 24);
  const context = (await h.send({ type: "GET_CONTEXT" })).context;
  assert.equal(context.durationSeconds, null);
  assert.equal(context.canLoop, false);
  assert.equal(context.isAd, true);
  assert.equal((await h.state()).ok, false);
  const command = await h.send({ type: "PLAYER_COMMAND", command: "seek", seconds: 10, videoId: "video-a" });
  assert.equal(command.ok, false);
  assert.match(command.error, /廣告/);
  h.page.isAd = false;
  h.page.video.duration = 7200;
  h.tick();
  assert.equal(h.page.video.currentTime, 10);
  assert.equal((await h.state()).state.loop.entryId, "song-a");
});

test("respects paused and hidden pages, then restarts a natural end-of-video loop", async () => {
  const h = harness({ video: makeVideo({ duration: 20 }) });
  await h.send(loopMessage());
  h.page.video.currentTime = 20;
  h.tick();
  assert.equal(h.page.video.currentTime, 20);
  assert.equal(h.page.video.playCalls, 0);
  h.page.video.paused = false;
  h.document.hidden = true;
  h.tick();
  assert.equal(h.page.video.currentTime, 20);
  h.document.hidden = false;
  h.page.video.paused = true;
  h.page.video.ended = true;
  h.page.video.dispatch("ended");
  await new Promise(setImmediate);
  assert.equal(h.page.video.currentTime, 10);
  assert.equal(h.page.video.paused, false);
  assert.equal(h.page.video.playCalls, 1);
});

test("does not report a pending command as successful after a SPA switch", async () => {
  const h = harness();
  let finishPlay;
  h.page.video.play = () => new Promise((resolve) => { finishPlay = resolve; });
  const request = h.dispatch({ type: "PLAYER_COMMAND", command: "seek", seconds: 10, entryId: "song-a", videoId: "video-a" });
  h.location.href = "https://m.youtube.com/watch?v=video-b";
  finishPlay();
  const response = await request.response;
  assert.equal(response.ok, false);
  assert.match(response.error, /切換|取代/);
  h.page.video.currentSrc = "media-b";
  assert.equal((await h.state()).state.selectedEntryId, null);
  assert.equal((await h.state()).state.loop, null);
});

test("clearing a loop cancels a queued end-of-video restart", async () => {
  const h = harness({ video: makeVideo({ duration: 20 }) });
  await h.send(loopMessage());
  h.page.video.currentTime = 20;
  h.page.video.ended = true;
  h.page.video.dispatch("ended");
  await h.send({ type: "CLEAR_LOOP", clearSelection: true });
  await new Promise(setImmediate);
  assert.equal(h.page.video.playCalls, 0);
  assert.equal((await h.state()).state.loop, null);
});

test("supports live/shorts URLs but rejects mismatched declared player identity", async () => {
  for (const path of ["live", "shorts"]) {
    const h = harness({ url: `https://m.youtube.com/${path}/video-a` });
    assert.equal((await h.state()).state.videoId, "video-a");
    h.page.declaredVideoId = "video-b";
    assert.equal((await h.send(loopMessage())).ok, false);
  }
});

test("rejects stale scan and playback requests even after the new video is ready", async () => {
  const h = harness();
  h.location.href = "https://m.youtube.com/watch?v=video-b";
  h.page.video.currentSrc = "media-b";
  h.page.nodes.set("ytm-expandable-video-description-body-renderer", node("0:00 Song B"));
  const staleScan = await h.send({ type: "SCAN_PAGE", videoId: "video-a" });
  assert.equal(staleScan.ok, false);
  assert.match(staleScan.error, /影片已切換/);
  assert.equal(staleScan.sources, undefined);
  assert.equal((await h.send({ type: "SCAN_PAGE", videoId: "video-b" })).ok, true);
  assert.equal((await h.send({ type: "GET_PLAYBACK_STATE", videoId: "video-a" })).ok, false);
  assert.equal((await h.send({ type: "GET_CONTEXT" })).context.videoId, "video-b");
});
