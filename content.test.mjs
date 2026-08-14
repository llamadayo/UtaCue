import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("broadcasts refreshed metadata after a YouTube SPA video switch", async () => {
  const source = await readFile(new URL("./content.js", import.meta.url), "utf8");
  const location = { href: "https://www.youtube.com/watch?v=video-a" };
  const page = {
    title: "Video A - YouTube",
    videoTitle: "Video A",
    channelName: "Channel A",
    metaThumbnail: "https://i.ytimg.com/vi/video-a/old-meta.jpg"
  };
  const video = { duration: 3600, currentTime: 0, paused: true };
  const messages = [];
  let intervalCallback = null;

  const document = {
    hidden: false,
    get title() { return page.title; },
    querySelector(selector) {
      if (selector.includes("video")) return video;
      if (selector.includes("h1")) return { textContent: page.videoTitle };
      if (selector.includes("channel-name")) return { textContent: page.channelName };
      if (selector === 'meta[property="og:image"]') return { content: page.metaThumbnail };
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const chrome = {
    runtime: {
      sendMessage(message) { messages.push(message); },
      onMessage: { addListener() {} }
    }
  };

  vm.runInNewContext(source, {
    URL,
    location,
    document,
    chrome,
    window: { addEventListener() {} },
    performance: { now: () => 1000 },
    setInterval(callback) { intervalCallback = callback; }
  });

  assert.equal(messages.filter((message) => message.type === "PAGE_CONTEXT_CHANGED").length, 1);

  location.href = "https://www.youtube.com/watch?v=video-b";
  intervalCallback();

  let contextMessages = messages.filter((message) => message.type === "PAGE_CONTEXT_CHANGED");
  assert.equal(contextMessages.length, 2);
  assert.equal(contextMessages.at(-1).context.videoId, "video-b");
  assert.equal(contextMessages.at(-1).context.videoTitle, "Video A");
  assert.equal(contextMessages.at(-1).context.thumbnailUrl, "https://i.ytimg.com/vi/video-b/hqdefault.jpg");

  page.title = "Video B - YouTube";
  page.videoTitle = "Video B";
  page.channelName = "Channel B";
  intervalCallback();

  contextMessages = messages.filter((message) => message.type === "PAGE_CONTEXT_CHANGED");
  assert.equal(contextMessages.length, 3);
  assert.equal(contextMessages.at(-1).context.videoId, "video-b");
  assert.equal(contextMessages.at(-1).context.videoTitle, "Video B");
  assert.equal(contextMessages.at(-1).context.channelName, "Channel B");

  intervalCallback();
  assert.equal(messages.filter((message) => message.type === "PAGE_CONTEXT_CHANGED").length, 3);
});
