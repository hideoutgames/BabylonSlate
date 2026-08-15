import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    };
  } catch {
    return {};
  }
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
  return zipSync(record, { level: 6, mtime: new Date(Date.UTC(1980, 0, 1)) });
}

/** Pack repo engine-plugins/ folders to public/engine-plugins for static hosts. */
export function enginePluginsVitePlugin(options: {
  sourceDir: string;
  publicDir: string;
}): Plugin {
  async function packAll(): Promise<void> {
    mkdirSync(options.publicDir, { recursive: true });
    let ids: string[] = [];
    try {
      ids = readdirSync(options.sourceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      ids = [];
    }
    const index: Array<{ id: string; file: string }> = [];
    for (const id of ids) {
      const files = readTree(path.join(options.sourceDir, id));
      if (files.length === 0) continue;
      const zip = packPluginZip(files);
      const file = `${id}.babplugin`;
      writeFileSync(path.join(options.publicDir, file), zip);
      index.push({ id, file });
    }
    writeFileSync(
      path.join(options.publicDir, "index.json"),
      `${JSON.stringify(index)}\n`,
    );
  }

  return {
    name: "babylonslate-engine-plugins",
    async buildStart() {
      await packAll();
    },
    configureServer(server) {
      void packAll();
      server.watcher.add(options.sourceDir);
    },
  };
}
