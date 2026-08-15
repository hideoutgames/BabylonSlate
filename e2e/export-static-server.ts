import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { AddressInfo } from "node:net";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

export function collectDirFiles(
  dir: string,
  prefix = "",
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [path, bytes] of collectDirFiles(abs, rel)) files.set(path, bytes);
    } else if (entry.isFile()) {
      files.set(rel, new Uint8Array(readFileSync(abs)));
    }
  }
  return files;
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function serveExportFiles(
  files: Map<string, Uint8Array>,
  options: { honorRange: boolean },
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const rel = decodeURIComponent(url.replace(/^\//, "")) || "index.html";
    const body = files.get(rel);
    if (!body) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const type = MIME[extname(rel).toLowerCase()] ?? "application/octet-stream";
    const range = options.honorRange ? parseRange(req.headers.range, body.byteLength) : null;
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (range) {
      const slice = body.subarray(range.start, range.end + 1);
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
        "Content-Length": slice.byteLength,
      });
      res.end(Buffer.from(slice));
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": body.byteLength,
    });
    res.end(Buffer.from(body));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
    server.on("error", reject);
  });
}

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile() || statSync(path).isDirectory();
  } catch {
    return false;
  }
}
