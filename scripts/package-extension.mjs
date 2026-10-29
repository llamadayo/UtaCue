import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { buildExtension } from "./build-extension.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Small, deterministic ZIP writer using only Node's standard library. Each
// archive contains the exact runtime allowlist, with manifest.json at its root.
export async function packageExtension(target, outputRoot) {
  const build = await buildExtension(target, outputRoot);
  const local = [];
  const central = [];
  let offset = 0;
  const fixedDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const filename of build.files) {
    const name = Buffer.from(filename, "utf8");
    const bytes = await readFile(join(build.directory, filename));
    const compressed = deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(fixedDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(fixedDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(build.files.length, 8);
  end.writeUInt16LE(build.files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = join(dirname(build.directory), `UtaCue-${target}-${build.manifest.version}.zip`);
  await writeFile(archive, Buffer.concat([...local, directory, end]));
  return { ...build, archive };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packageExtension(process.argv[2] ?? "safari");
  console.log(`Packaged ${result.target}: ${result.archive}`);
}
