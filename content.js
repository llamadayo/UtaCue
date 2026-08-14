(() => {
  let lastVideoId = null;
  let lastContextSignature = null;
  let loopConfig = null;
  let lastPlaybackBroadcast = 0;

  function getVideoId() {
    try {
      return new URL(location.href).searchParams.get("v");
    } catch {
      return null;
    }
  }

  function getVideo() {
    return document.querySelector("video.html5-main-video, #movie_player video, video");
  }

  function textFrom(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.textContent?.trim();
      if (value) return value;
    }
    return "";
  }

  function getContext() {
    const video = getVideo();
    const videoId = getVideoId();
    const duration = Number.isFinite(video?.duration) ? video.duration : null;
    const metaThumbnail = document.querySelector('meta[property="og:image"]')?.content;
    return {
      videoId,
      videoTitle: textFrom([
        "ytd-watch-metadata h1 yt-formatted-string",
        "h1.title yt-formatted-string",
        'meta[property="og:title"]'
      ]) || document.title.replace(/\s*-\s*YouTube$/, ""),
      channelName: textFrom([
        "ytd-watch-metadata ytd-channel-name a",
        "#owner ytd-channel-name a",
        "ytd-channel-name a"
      ]),
      durationSeconds: duration,
      // YouTube updates Open Graph metadata after SPA navigation. Prefer the URL
      // derived from the current video ID so the previous video's image cannot
      // remain visible while the rest of the watch page is being replaced.
      thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : (metaThumbnail || ""),
      hasVideo: Boolean(video),
      canLoop: Boolean(video && duration && duration !== Infinity),
      isLive: Boolean(video && (!duration || duration === Infinity))
    };
  }

  function collectSources() {
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

    const descriptionSelectors = [
      "ytd-watch-metadata #description-inline-expander",
      "#description-inline-expander",
      "ytd-video-secondary-info-renderer #description",
      "#description"
    ];
    for (const selector of descriptionSelectors) {
      const element = document.querySelector(selector);
      if (element?.innerText?.trim()) {
        push("description", element.innerText);
        break;
      }
    }

    document.querySelectorAll("ytd-comment-thread-renderer").forEach((thread) => {
      const content = thread.querySelector("#content-text")?.innerText;
      const author = thread.querySelector("#author-text")?.textContent?.trim() || "";
      push("comment", content, author);
    });

    return { context: getContext(), sources };
  }

  function emit(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result?.catch) result.catch(() => {});
    } catch {
      // Side panel may not be open.
    }
  }

  function contextSignature(context) {
    return JSON.stringify([
      context.videoId,
      context.videoTitle,
      context.channelName,
      context.durationSeconds,
      context.thumbnailUrl,
      context.hasVideo,
      context.canLoop,
      context.isLive
    ]);
  }

  function announceContext() {
    const context = getContext();
    if (context.videoId !== lastVideoId) {
      loopConfig = null;
      lastVideoId = context.videoId;
    }
    const signature = contextSignature(context);
    if (signature === lastContextSignature) return;
    lastContextSignature = signature;
    emit({ type: "PAGE_CONTEXT_CHANGED", context });
  }

  function applyPlayerCommand(payload) {
    const video = getVideo();
    if (!video) throw new Error("目前頁面找不到播放器");
    switch (payload.command) {
      case "seek":
        video.currentTime = Math.max(0, Number(payload.seconds) || 0);
        if (payload.play !== false) video.play().catch(() => {});
        break;
      case "toggle":
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        break;
      case "play":
        video.play().catch(() => {});
        break;
      case "pause":
        video.pause();
        break;
      default:
        throw new Error("未知的播放指令");
    }
  }

  function tickPlayback() {
    const video = getVideo();
    if (!video) return;
    if (loopConfig?.enabled
      && Number.isFinite(loopConfig.startSeconds)
      && Number.isFinite(loopConfig.endSeconds)
      && loopConfig.endSeconds > loopConfig.startSeconds
      && video.currentTime >= loopConfig.endSeconds - 0.08) {
      video.currentTime = loopConfig.startSeconds;
      if (!video.paused) video.play().catch(() => {});
    }

    const now = performance.now();
    if (now - lastPlaybackBroadcast > 400) {
      lastPlaybackBroadcast = now;
      emit({
        type: "PLAYBACK_STATE",
        state: {
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          paused: video.paused,
          videoId: getVideoId()
        }
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "GET_CONTEXT") sendResponse({ ok: true, context: getContext() });
      else if (message?.type === "SCAN_PAGE") sendResponse({ ok: true, ...collectSources() });
      else if (message?.type === "PLAYER_COMMAND") {
        applyPlayerCommand(message);
        sendResponse({ ok: true });
      } else if (message?.type === "SET_LOOP") {
        loopConfig = {
          enabled: Boolean(message.enabled),
          startSeconds: Number(message.startSeconds),
          endSeconds: Number(message.endSeconds),
          entryId: message.entryId || null
        };
        sendResponse({ ok: true });
      } else if (message?.type === "CLEAR_LOOP") {
        loopConfig = null;
        sendResponse({ ok: true });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });

  window.addEventListener("yt-navigate-finish", announceContext);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) announceContext();
  });
  setInterval(() => {
    // A YouTube SPA navigation can expose the new video ID before its title and
    // channel nodes update. Keep checking the complete context so the side panel
    // receives the later metadata update for the same video ID.
    announceContext();
    tickPlayback();
  }, 250);

  lastVideoId = getVideoId();
  announceContext();
})();
