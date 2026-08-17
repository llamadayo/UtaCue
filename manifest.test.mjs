import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("manifest uses the UtaCue icon for extension and action surfaces", async () => {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  const iconPath = "utacue-icon.png";

  assert.deepEqual(manifest.icons, {
    "16": iconPath,
    "32": iconPath,
    "48": iconPath,
    "128": iconPath
  });
  assert.deepEqual(manifest.action.default_icon, {
    "16": iconPath,
    "32": iconPath
  });
  await access(new URL(`./${iconPath}`, import.meta.url));
});
