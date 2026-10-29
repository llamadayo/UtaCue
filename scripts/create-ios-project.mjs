import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildExtension, projectRoot } from "./build-extension.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

if (process.platform !== "darwin") {
  console.error("建立 iOS Xcode 專案需要在已安裝 Xcode 的 Mac 執行。其他平台可先執行 npm run package:safari。");
  process.exit(1);
}

const destination = resolve(option("--output", join(projectRoot, "build", "ios")));
const bundleId = option("--bundle-id", "dev.llamadayo.utacue");
if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error("請提供有效的反向 DNS bundle identifier");
let exists = false;
try { await access(destination); exists = true; } catch {}
if (exists) throw new Error("輸出位置已存在。請用 --output 指定新的資料夾，避免覆寫已設定簽署的專案。");

const tool = ["safari-web-extension-packager", "safari-web-extension-converter"]
  .find((name) => spawnSync("xcrun", ["--find", name], { stdio: "ignore" }).status === 0);
if (!tool) throw new Error("找不到 Safari extension packager。請安裝完整 Xcode 並確認 xcode-select 指向該版本。");

const build = await buildExtension("safari");
const result = spawnSync("xcrun", [
  tool, build.directory, "--project-location", destination,
  "--app-name", "UtaCue", "--bundle-identifier", bundleId,
  "--swift", "--ios-only", "--copy-resources", "--no-open", "--no-prompt"
], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Xcode 專案已產生：${destination}`);
console.log("請在 Xcode 選擇簽署 Team，確認 App/Extension 的 iOS Deployment Target 為 16.4 或更新，然後在 iPhone 執行。");
