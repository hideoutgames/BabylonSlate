import { createServer, type Server } from "node:http";
import { extname } from "node:path";
import type { AddressInfo } from "node:net";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

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

export type ServedExportRequest = {
  path: string;
  status: number;
  range: string | null;
  /** Response body bytes handed to the local static server connection. */
  bytes: number;
};

export async function serveExportFiles(
  files: Map<string, Uint8Array>,
  options: { honorRange: boolean },
): Promise<{ url: string; requests: ServedExportRequest[]; close: () => Promise<void> }> {
  const requests: ServedExportRequest[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const rel = decodeURIComponent(url.replace(/^\//, "")) || "index.html";
    const body = files.get(rel);
    if (!body) {
      requests.push({ path: rel, status: 404, range: req.headers.range ?? null, bytes: 9 });
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
      requests.push({ path: rel, status: 206, range: req.headers.range ?? null, bytes: slice.byteLength });
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
        "Content-Length": slice.byteLength,
      });
      res.end(Buffer.from(slice));
      return;
    }
    requests.push({ path: rel, status: 200, range: req.headers.range ?? null, bytes: body.byteLength });
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
        requests,
        close: () =>
          new Promise((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
    server.on("error", reject);
  });
}
