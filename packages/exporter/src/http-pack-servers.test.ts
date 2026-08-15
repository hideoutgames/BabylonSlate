import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { encodeBabpack } from "./babpack";
import { createHttpPackSource } from "./pack-source";

function listen(handler: (req: IncomingMessage, body: Uint8Array) => { status: number; body: Uint8Array; headers?: Record<string, string> }, pack: Uint8Array): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const range = req.headers.range;
    const result = handler(req, pack);
    void range;
    res.writeHead(result.status, {
      "Content-Type": "application/octet-stream",
      ...result.headers,
    });
    res.end(Buffer.from(result.body));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/boot.babpack`,
        close: () =>
          new Promise((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
    server.on("error", reject);
  });
}

describe("HTTP pack dual servers", () => {
  it("reads from a range-capable server and a range-blind server", async () => {
    const payload = new TextEncoder().encode("dual-server-asset");
    const pack = await encodeBabpack([{ guid: "scene-1", bytes: payload }]);

    const rangeServer = await listen((req) => {
      const range = String(req.headers.range ?? "");
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) {
        return { status: 200, body: pack };
      }
      const start = Number(match[1]);
      const end = Number(match[2]) + 1;
      const slice = pack.subarray(start, end);
      return {
        status: 206,
        body: slice,
        headers: {
          "Content-Range": `bytes ${start}-${end - 1}/${pack.byteLength}`,
        },
      };
    }, pack);

    const blindServer = await listen(() => ({ status: 200, body: pack }), pack);

    try {
      const ranged = createHttpPackSource(rangeServer.url);
      expect(await ranged.read("scene-1")).toEqual(payload);

      const blind = createHttpPackSource(blindServer.url);
      expect(await blind.read("scene-1")).toEqual(payload);
    } finally {
      await rangeServer.close();
      await blindServer.close();
    }
  });
});
