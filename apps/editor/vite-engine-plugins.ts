import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { zipSync } from "fflate";
import type { Plugin } from "vite";

interface TreeFile {
  path: string;
  data: Uint8Array;
}

function readTree(dir: string, prefix = ""): TreeFile[] {
  const out: TreeFile[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readTree(abs, rel));
    } else if (entry.isFile()) {
      out.push({ path: rel, data: new Uint8Array(readFileSync(abs)) });
    }
  }
  return out;
}

function readBabassetHeader(bytes: Uint8Array): {
  type?: string;
  guid?: string;
  name?: string;
  engineVersion?: string;
  chunks?: Array<{ locator: { inline?: { offset: number; length: number } } }>;
} {
  if (bytes.byteLength < 12) return {};
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== "BABA") return {};
  const headerLen = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(8, true);
  const json = new TextDecoder().decode(bytes.subarray(12, 12 + headerLen));
  try {
    return JSON.parse(json) as {
      type?: string;
      guid?: string;
      name?: string;
      engineVersion?: string;
      chunks?: Array<{ locator: { inline?: { offset: number; length: number } } }>;
    };
  } catch {
    return {};
  }
}

/** Preserve the file address space while making every ordinary catalog/chunk read a whole HTTP object. */
function emitAddressableFile(file: TreeFile, publicDir: string) {
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const boundaries = new Set([0, file.data.byteLength]);
  if (file.path.endsWith(".babasset")) {
    const header = readBabassetHeader(file.data);
    if (!header.guid || file.data.byteLength < 12) throw new Error(`Invalid engine asset: ${file.path}`);
    const headerEnd = 12 + new DataView(file.data.buffer, file.data.byteOffset, file.data.byteLength).getUint32(8, true);
    if (headerEnd > file.data.byteLength) throw new Error(`Truncated engine asset header: ${file.path}`);
    boundaries.add(12);
    boundaries.add(headerEnd);
    for (const chunk of header.chunks ?? []) {
      if (!chunk.locator.inline) continue;
      const start = headerEnd + chunk.locator.inline.offset;
      const end = start + chunk.locator.inline.length;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < headerEnd || end < start || end > file.data.byteLength) {
        throw new Error(`Invalid engine asset chunk: ${file.path}`);
      }
      boundaries.add(start);
      boundaries.add(end);
    }
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const parts = points.slice(1).map((end, index) => {
    const offset = points[index]!;
    const bytes = file.data.subarray(offset, end);
    const sha256 = hash(bytes);
    const output = `content/${sha256}`;
    writeFileSync(path.join(publicDir, output), bytes);
    return { offset, length: bytes.byteLength, file: output, sha256 };
  });
  return { path: file.path, size: file.data.byteLength, revision: hash(file.data), parts };
}

function packPluginZip(files: TreeFile[]): Uint8Array {
  const settings = files
    .filter((file) => file.path.endsWith(".babasset"))
    .map((file) => ({ file, header: readBabassetHeader(file.data) }))
    .filter((entry) => entry.header.type === "PluginSettings")
    .sort((a, b) => a.file.path.length - b.file.path.length)[0];
  if (!settings?.header.guid) {
    throw new Error("Engine plugin folder is missing PluginSettings");
  }
  const record: Record<string, Uint8Array> = {};
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (file.path === "plugin.json" || file.path.endsWith("/plugin.json")) {
      continue;
    }
    record[file.path] = file.data;
  }
  const manifest = {
    kind: "plugin",
    guid: settings.header.guid,
    name: settings.header.name ?? settings.header.guid,
    engineVersion: settings.header.engineVersion ?? "0.0.0",
    version: 1,
  };
  record["plugin.json"] = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  // Local noon: fflate DOS dates use local getters; UTC midnight 1980 fails west of UTC.
  return zipSync(record, { level: 6, mtime: new Date(1980, 0, 1, 12, 0, 0) });
}

/** Emit lightweight catalogs and immutable payload objects; ZIPs remain explicit export downloads. */
export function enginePluginsVitePlugin(options: {
  sourceDir: string;
  publicDir: string;
}): Plugin {
  async function packAll(): Promise<void> {
    mkdirSync(options.publicDir, { recursive: true });
    mkdirSync(path.join(options.publicDir, "content"), { recursive: true });
    let ids: string[];
    try {
      ids = readdirSync(options.sourceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      ids = [];
    }
    const index: Array<{ id: string; file: string }> = [];
    const catalogFiles: Array<ReturnType<typeof emitAddressableFile>> = [];
    for (const id of ids) {
      const files = readTree(path.join(options.sourceDir, id));
      if (files.length === 0) continue;
      const zip = packPluginZip(files);
      const file = `${id}.babplugin`;
      writeFileSync(path.join(options.publicDir, file), zip);
      index.push({ id, file });
      for (const entry of files) catalogFiles.push(emitAddressableFile({ ...entry, path: `${id}/${entry.path}` }, options.publicDir));
    }
    writeFileSync(
      path.join(options.publicDir, "index.json"),
      `${JSON.stringify({ version: 1, plugins: index, files: catalogFiles })}\n`,
    );
  }

  return {
    name: "babylonslate-engine-plugins",
    // Pack during config resolution so the dev server's publicDir whitelist
    // snapshot (built before configureServer) includes the generated
    // index.json and *.babplugin files.
    async configResolved() {
      await packAll();
    },
    configureServer(server) {
      server.watcher.add(options.sourceDir);
    },
  };
}
