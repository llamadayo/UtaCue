import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeFiles = [
  "sidepanel.html", "sidepanel.css", "sidepanel.js", "core.mjs", "storage.mjs",
  "extension-api.mjs", "backup.mjs", "content.js", "utacue-icon.png",
  "fallback-thumbnail.png", "LICENSE"
];

export async function buildExtension(target, outputRoot = join(projectRoot, "dist")) {
  if (!["safari", "chrome"].includes(target)) throw new Error("Target must be safari or chrome");
  const manifest = JSON.parse(await readFile(join(projectRoot, "manifest.json"), "utf8"));
  const files = [...runtimeFiles];
  if (target === "safari") {
    delete manifest.minimum_chrome_version;
    delete manifest.side_panel;
    delete manifest.background;
    manifest.permissions = manifest.permissions.filter((permission) => permission !== "sidePanel");
    manifest.action.default_popup = "sidepanel.html";
    manifest.browser_specific_settings = { safari: { strict_min_version: "16.4" } };
  } else {
    files.push("background.js");
  }
  const directory = join(resolve(outputRoot), target);
  // Only replace this target's generated output, never source or an Xcode project.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await Promise.all(files.map((file) => copyFile(join(projectRoot, file), join(directory, file))));
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { target, directory, manifest, files: ["manifest.json", ...files].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv[2] ?? "all";
  const targets = requested === "all" ? ["chrome", "safari"] : [requested];
  for (const target of targets) {
    const result = await buildExtension(target);
    console.log(`Built ${target}: ${result.directory}`);
  }
}
