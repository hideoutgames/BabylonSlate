import { describe, expect, it } from "vitest";
import { createPreviewAssetClient, createPreviewAssetServer } from "./preview-assets";
import { previewPackFromFiles } from "./preview-protocol";

describe("on-demand Preview files", () => {
  it("sends only the catalog at handoff and transfers the selected file on demand", async () => {
    const encoder = new TextEncoder();
    const files = new Map([
      ["game.json", encoder.encode(JSON.stringify({ scriptsFile: "scripts.js" }))],
      ["scripts.js", encoder.encode("void 0")],
      ["assets/a.bin", new Uint8Array([1, 2])],
      ["assets/b.bin", new Uint8Array([3, 4])],
    ]);
    const handoff = previewPackFromFiles(files, { onDemand: true });
    expect(Object.keys(handoff.files)).toEqual(["game.json", "scripts.js"]);
    const transferred: number[] = [];
    const server = createPreviewAssetServer({ files, send: (message, transfer) => { transferred.push(...transfer.map(value => (value as ArrayBuffer).byteLength)); client.receive(message); } });
    const client = createPreviewAssetClient({ send: message => server.receive(message) });
    try {
      expect(await client.readFile("assets/b.bin", new AbortController().signal)).toEqual(new Uint8Array([3, 4]));
      expect(transferred).toEqual([2]);
      expect(files.get("assets/a.bin")).toEqual(new Uint8Array([1, 2]));
      await expect(client.readFile("assets/missing.bin", new AbortController().signal)).rejects.toThrow(/missing/);
    } finally { client.dispose(); server.dispose(); }
  });

  it("settles cancelled and stopped requests even when the host never replies", async () => {
    const client = createPreviewAssetClient({ send: () => {} });
    const controller = new AbortController();
    const pending = client.readFile("assets/a.bin", controller.signal);
    controller.abort(new Error("Scene unloaded"));
    await expect(pending).rejects.toThrow("Scene unloaded");
    const stopped = client.readFile("assets/b.bin", new AbortController().signal);
    client.dispose();
    await expect(stopped).rejects.toThrow(/closed/);
  });
});
