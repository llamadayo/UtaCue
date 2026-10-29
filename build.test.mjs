import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtension } from "./scripts/build-extension.mjs";

test("Safari bundle has popup, complete local modules, and only YouTube host access", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "utacue-build-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const build = await buildExtension("safari", temporary);
  assert.equal(build.manifest.action.default_popup, "sidepanel.html");
  assert.equal(build.manifest.background, undefined);
  assert.equal(build.manifest.side_panel, undefined);
  assert.equal(build.manifest.minimum_chrome_version, undefined);
  assert.deepEqual(build.manifest.permissions, ["storage"]);
  assert.deepEqual(build.manifest.host_permissions, ["https://www.youtube.com/*", "https://m.youtube.com/*"]);
  assert.deepEqual(build.manifest.content_scripts[0].matches, build.manifest.host_permissions);
  const files = await readdir(build.directory);
  assert.deepEqual(files.sort(), build.files);
  assert.ok(!files.some((name) => name.includes("test") || name.startsWith(".")));
  for (const name of files.filter((file) => /\.(m?js)$/.test(file))) {
    const source = await readFile(join(build.directory, name), "utf8");
    for (const match of source.matchAll(/from\s+["']\.\/([^"']+)["']/g)) await access(join(build.directory, match[1]));
  }
  await access(join(build.directory, build.manifest.action.default_popup));
});

test("Chrome bundle keeps its existing side-panel entry point", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "utacue-chrome-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const build = await buildExtension("chrome", temporary);
  assert.equal(build.manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(build.manifest.action.default_popup, undefined);
  assert.equal(build.manifest.background.service_worker, "background.js");
  assert.ok(build.manifest.permissions.includes("sidePanel"));
  await access(join(build.directory, "background.js"));
});
