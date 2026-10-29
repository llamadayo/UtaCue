(() => {
  const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;
  let lastVideoId = null;
  let lastContextSignature = null;
  let loopConfig = null;
  let selectedEntryId = null;
  let lastPlaybackBroadcast = 0;
  let observedVideo = null;
  let observedSource = "";
  let pendingMedia = null;
  let commandSequence = 0;
  let restartingLoop = false;

  function getVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === "/watch") return url.searchParams.get("v");
      return url.pathname.match(/^\/(?:live|shorts)\/([^/]+)/)?.[1] || null;
    } catch {
      return null;
    }
  }

  function getVideo() {
    if (!getVideoId()) return null;
    return document.querySelector("video.html5-main-video, #movie_player video, #player video, ytm-player video")
      || document.querySelector("video");
  }

  function mediaSource(video) {
    return video?.currentSrc || video?.src || "";
  }

  function isAdPlaying() {
    return Boolean(document.querySelector(
      "#movie_player.ad-showing, #movie_player.ad-interrupting, .html5-video-player.ad-showing, .html5-video-player.ad-interrupting"
    ));
  }

  function declaredPlayerMatches() {
    const watch = document.querySelector("ytd-watch-flexy[video-id], ytm-watch[video-id]");
    const declaredId = watch?.getAttribute?.("video-id");
    return !declaredId || declaredId === getVideoId();
  }

  function metadataAvailable(video) {
    return video && (video.readyState === undefined || video.readyState >= 1);
  }

  function onLoadedMetadata(event) {
    refreshPageState();
    if (event.currentTarget === observedVideo && !isAdPlaying() && declaredPlayerMatches()) {
      pendingMedia = null;
      observedSource = mediaSource(observedVideo);
    }
    announceContext();
  }

  function observeVideo(video) {
    if (video === observedVideo) return;
    for (const [name, callback] of [["loadedmetadata", onLoadedMetadata], ["timeupdate", tickPlayback], ["ended", tickPlayback]]) {
      observedVideo?.removeEventListener?.(name, callback);
      video?.addEventListener?.(name, callback);
    }
    observedVideo = video;
  }

  // Run before commands and ticks: messages may arrive before YouTube's
  // navigation-finish event, while the reused video still contains old media.
  function refreshPageState() {
    const videoId = getVideoId();
    const video = getVideo();
    const source = mediaSource(video);
    if (videoId !== lastVideoId) {
      loopConfig = null;
      selectedEntryId = null;
      commandSequence += 1;
      pendingMedia = lastVideoId && video && video === observedVideo
        && (!source || source === observedSource) ? { video, source: observedSource } : null;
      lastVideoId = videoId;
    }
    if (pendingMedia && metadataAvailable(video)
      && (video !== pendingMedia.video || (source && source !== pendingMedia.source))
      && !isAdPlaying() && declaredPlayerMatches()) {
      pendingMedia = null;
    }
    observeVideo(video);
    observedSource = source;
    return video;
  }

  function playerReady(video) {
    return Boolean(metadataAvailable(video) && !pendingMedia && declaredPlayerMatches() && !isAdPlaying());
  }

  function textFrom(selectors, root = document) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = (element?.content || element?.innerText || element?.textContent)?.trim();
      if (value) return value;
    }
    return "";
  }

  function getContext() {
    const video = refreshPageState();
    const videoId = getVideoId();
    const ready = playerReady(video);
    const duration = ready && Number.isFinite(video?.duration) ? video.duration : null;
    const metaThumbnail = document.querySelector('meta[property="og:image"]')?.content;
    return {
      videoId,
      videoTitle: textFrom([
        "ytd-watch-metadata h1 yt-formatted-string",
        "h1.title yt-formatted-string",
        "ytm-slim-video-metadata-renderer .slim-video-metadata-title",
        "ytm-video-description-header-renderer .yt-core-attributed-string",
        ".slim-video-metadata-title",
        'meta[property="og:title"]'
      ]) || document.title.replace(/\s*-\s*YouTube$/, ""),
      channelName: textFrom([
        "ytd-watch-metadata ytd-channel-name a",
        "#owner ytd-channel-name a",
        "ytd-channel-name a",
        "ytm-slim-owner-renderer .slim-owner-channel-name",
        "ytm-slim-owner-renderer .slim-owner-channel-name-and-badges",
        "ytm-video-owner-renderer .yt-core-attributed-string",
        ".slim-owner-channel-name"
      ]),
      durationSeconds: duration,
      // Open Graph metadata can still belong to the previous SPA page.
      thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : (metaThumbnail || ""),
      hasVideo: Boolean(video),
      canLoop: Boolean(ready && duration > 0),
      isLive: Boolean(ready && video.duration === Infinity),
      isAd: isAdPlaying(),
      playerReady: ready
    };
  }

  function collectSources(expectedVideoId) {
    const context = getContext();
    if (!context.videoId) throw new Error("請先開啟 YouTube 影片頁面");
    if (expectedVideoId !== undefined && expectedVideoId !== context.videoId) throw new Error("影片已切換，請重新掃描目前影片");
    if (pendingMedia || !declaredPlayerMatches()) throw new Error("影片正在切換，請等載入完成後再掃描");
    const sources = [];
    const seen = new Set();
    const push = (type, rawText, author = "") => {
      const text = rawText?.trim();
      if (!text) return;
      const key = `${type}|${author}|${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      sources.push({ type, rawText: text, author });
    };

    push("description", textFrom([
      "ytd-watch-metadata #description-inline-expander",
      "#description-inline-expander",
      "ytd-video-secondary-info-renderer #description",
      "ytm-expandable-video-description-body-renderer",
      "ytm-slim-video-description-renderer .slim-video-description-content",
      "ytm-slim-video-description-renderer",
      "ytm-slim-video-metadata-renderer .slim-video-metadata-description",
      ".slim-video-metadata-description",
      ".expandable-video-description-body",
      "#description"
    ]));

    // Read only comments already rendered by YouTube; never silently imply a
    // complete scan of comments that have not been loaded by the user.
    document.querySelectorAll(
      "ytd-comment-thread-renderer, ytm-comment-thread-renderer, ytm-comment-renderer, ytm-comment-view-model"
    ).forEach((thread) => {
      const content = textFrom([
        "#content-text", ".comment-text", ".comment-content .yt-core-attributed-string", ".comment-content"
      ], thread);
      const author = textFrom([
        "#author-text", ".comment-title-author", ".comment-author-text", ".comment-title", ".comment-author"
      ], thread);
      push("comment", content, author);
    });

    return { context, sources };
  }

  function emit(message) {
    try {
      const result = runtime?.sendMessage(message);
      if (result?.catch) result.catch(() => {});
    } catch {
      // A closed popup must never affect page playback or loop state.
    }
  }

  function announceContext() {
    const context = getContext();
    const signature = JSON.stringify(context);
    if (signature === lastContextSignature) return;
    lastContextSignature = signature;
    emit({ type: "PAGE_CONTEXT_CHANGED", context });
  }

  function requirePlayer(videoId) {
    const video = refreshPageState();
    if (videoId !== undefined && videoId !== getVideoId()) throw new Error("影片已切換，請重新選取目前影片的歌曲");
    if (!video) throw new Error("目前頁面找不到播放器");
    if (isAdPlaying()) throw new Error("廣告播放中，請等正片開始後再操作");
    if (!playerReady(video)) throw new Error("播放器正在載入或切換影片，請稍後再試");
    return video;
  }

  function finiteTime(value, name) {
    if ((typeof value !== "number" && typeof value !== "string") || value === "" || (typeof value === "string" && !value.trim())) {
      throw new Error(`${name}必須是有效的秒數`);
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`${name}必須是有效的非負秒數`);
    return seconds;
  }

  function getPlaybackState(expectedVideoId) {
    const video = requirePlayer(expectedVideoId);
    if (!Number.isFinite(video.currentTime) || video.currentTime < 0) {
      throw new Error("目前無法取得播放時間，請稍後再試");
    }
    return {
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused,
      videoId: getVideoId(),
      loop: loopConfig ? { ...loopConfig } : null,
      selectedEntryId
    };
  }

  function optionalPlaybackState() {
    try { return getPlaybackState(); } catch { return null; }
  }

  async function applyPlayerCommand(payload) {
    const video = requirePlayer(payload.videoId);
    const videoId = getVideoId();
    let shouldPlay = false;
    switch (payload.command) {
      case "seek": {
        const seconds = finiteTime(payload.seconds, "播放時間");
        if (Number.isFinite(video.duration) && seconds > video.duration) throw new Error("播放時間不可超過影片長度");
        const selectingEntry = Object.hasOwn(payload, "entryId");
        const includesLoop = Object.hasOwn(payload, "loop");
        let nextLoop = null;
        const nextEntryId = payload.entryId || null;
        if (includesLoop) {
          if (!selectingEntry) throw new Error("設定選歌循環時必須提供歌曲識別碼");
          if (payload.loop !== null) {
            if (typeof payload.loop !== "object" || Array.isArray(payload.loop) || payload.loop.enabled !== true) {
              throw new Error("選歌循環設定無效");
            }
            if (payload.loop.entryId !== undefined && (payload.loop.entryId || null) !== nextEntryId) {
              throw new Error("循環與選取的歌曲不一致");
            }
            nextLoop = validatedLoop(payload.loop, video, nextEntryId);
          }
        }
        // Validate everything before touching playback, then install selection,
        // seek, and loop in the same synchronous turn. A popup can close while
        // play() is pending without losing a later SET_LOOP message.
        video.currentTime = seconds;
        if (selectingEntry) {
          loopConfig = nextLoop;
          selectedEntryId = nextEntryId;
        }
        shouldPlay = payload.play !== false;
        break;
      }
      case "toggle":
        if (video.paused) shouldPlay = true;
        else video.pause();
        break;
      case "play":
        shouldPlay = true;
        break;
      case "pause":
        video.pause();
        break;
      default:
        throw new Error("未知的播放指令");
    }
    const sequence = ++commandSequence;
    let playbackBlocked = false;
    if (shouldPlay) {
      try {
        await video.play();
      } catch (error) {
        if (error?.name === "NotAllowedError") playbackBlocked = true;
        else throw new Error(`播放失敗：${error?.message || "播放器未能開始播放"}`);
      }
    }
    refreshPageState();
    if (sequence !== commandSequence || videoId !== getVideoId() || video !== getVideo()) {
      throw new Error("播放操作已被新的操作或影片切換取代，請重新選歌");
    }
    const state = getPlaybackState();
    emit({ type: "PLAYBACK_STATE", state });
    return playbackBlocked
      ? { ok: true, playbackBlocked: true, message: "已定位歌曲；Safari 需要你先點一下影片播放，再使用循環。", state }
      : { ok: true, state };
  }

  function validatedLoop(message, video, fallbackEntryId = selectedEntryId) {
    if (message.videoId !== undefined && message.videoId !== getVideoId()) throw new Error("循環影片已切換，請重新選歌");
    const startSeconds = finiteTime(message.startSeconds, "循環起點");
    const endSeconds = finiteTime(message.endSeconds, "循環終點");
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("目前影片沒有固定長度，無法設定循環");
    if (endSeconds <= startSeconds) throw new Error("循環終點必須晚於起點");
    if (endSeconds > video.duration) throw new Error("循環範圍不可超過影片長度");
    const entryId = message.entryId || fallbackEntryId || null;
    return { enabled: true, startSeconds, endSeconds, entryId, videoId: getVideoId() };
  }

  function setLoop(message) {
    const video = requirePlayer(message.videoId);
    if (message.enabled === false) {
      loopConfig = null;
      return { ok: true, state: getPlaybackState() };
    }
    loopConfig = validatedLoop(message, video);
    if (loopConfig.entryId) selectedEntryId = loopConfig.entryId;
    return { ok: true, state: getPlaybackState() };
  }

  function tickPlayback() {
    const video = refreshPageState();
    // Foreground playback is supported. iOS may suspend background pages;
    // neither popup lifetime nor an extension background timer is needed.
    if (!video || document.hidden || !playerReady(video)) return;
    if (loopConfig?.enabled && loopConfig.videoId === getVideoId()
      && Number.isFinite(video.duration) && loopConfig.endSeconds <= video.duration
      && (!video.paused || video.ended)
      && video.currentTime >= loopConfig.endSeconds - 0.08 && !restartingLoop) {
      const wasEnded = video.ended;
      video.currentTime = loopConfig.startSeconds;
      if (wasEnded) {
        const restartingConfig = loopConfig;
        const sequence = commandSequence;
        restartingLoop = true;
        Promise.resolve().then(() => {
          refreshPageState();
          if (loopConfig !== restartingConfig || sequence !== commandSequence
            || video !== getVideo() || !playerReady(video)) return;
          return video.play();
        }).catch((error) => {
          emit({ type: "PLAYBACK_ERROR", error: error?.name === "NotAllowedError"
            ? "請點一下影片播放，以繼續循環。" : `循環播放失敗：${error?.message || "請重新播放"}` });
        }).finally(() => {
          restartingLoop = false;
          const state = optionalPlaybackState();
          if (state) emit({ type: "PLAYBACK_STATE", state });
        });
      }
    }

    const now = performance.now();
    if (now - lastPlaybackBroadcast > 400) {
      lastPlaybackBroadcast = now;
      const state = optionalPlaybackState();
      if (state) emit({ type: "PLAYBACK_STATE", state });
    }
  }

  runtime?.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PLAYER_COMMAND") {
      applyPlayerCommand(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message, state: optionalPlaybackState() }));
      return true; // Keep Safari and Chrome response channels open for play().
    }
    try {
      if (message?.type === "GET_CONTEXT") sendResponse({ ok: true, context: getContext() });
      else if (message?.type === "GET_PLAYBACK_STATE") sendResponse({ ok: true, state: getPlaybackState(message.videoId) });
      else if (message?.type === "SCAN_PAGE") sendResponse({ ok: true, ...collectSources(message.videoId) });
      else if (message?.type === "SET_LOOP") sendResponse(setLoop(message));
      else if (message?.type === "CLEAR_LOOP") {
        refreshPageState();
        if (message.videoId !== undefined && message.videoId !== getVideoId()) throw new Error("影片已切換，請重新操作");
        loopConfig = null;
        if (message.clearSelection) selectedEntryId = null;
        sendResponse({ ok: true, state: optionalPlaybackState() });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });

  window.addEventListener("yt-navigate-start", () => {
    loopConfig = null;
    selectedEntryId = null;
    commandSequence += 1;
  });
  window.addEventListener("yt-navigate-finish", announceContext);
  window.addEventListener("yt-page-data-updated", announceContext);
  window.addEventListener("popstate", announceContext);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) announceContext();
  });
  setInterval(() => {
    // Metadata can update after the URL, especially on mobile YouTube.
    announceContext();
    tickPlayback();
  }, 250);

  announceContext();
})();
