import { describe, expect, it, vi } from "vitest";
import type { BabassetHeader } from "@babylonslate/assets";
import { collectGpuTextureBytes, texturePixelSizesFromHeaders } from "./collect-gpu-texture-bytes";

function textureHeader(
  chunks: BabassetHeader["chunks"],
  payload: Record<string, unknown> = {},
): BabassetHeader {
  return {
    guid: "tex-1",
    type: "Texture",
    name: "Hero",
    engineVersion: "0.0.0",
    version: 1,
    mode: "thin",
    dependencies: [],
    payload,
    chunks,
  };
}

describe("collectGpuTextureBytes", () => {
  it("loads texture parameter literals and typed variable defaults from gameplay graphs", async () => {
    const eventBytes = new Uint8Array([1, 2, 3]);
    const functionBytes = new Uint8Array([4, 5, 6]);
    const classBytes = new Uint8Array([7, 8, 9]);
    const localBytes = new Uint8Array([10, 11, 12]);
    const sources = new Map([
      ["assets/tex-event.texture.babasset", eventBytes],
      ["assets/tex-function.texture.babasset", functionBytes],
      ["assets/tex-class.texture.babasset", classBytes],
      ["assets/tex-local.texture.babasset", localBytes],
    ]);
    const readChunk = async (path: string, chunkId: string) =>
      chunkId === "pixels" ? sources.get(path) ?? null : null;
    const parameterNode = (id: string, guid: string) => ({
      id,
      type: "material.setTextureParameter",
      position: { x: 0, y: 0 },
      data: { properties: { "default:name": "Albedo", "default:value": guid } },
    });
    const bytes = await collectGpuTextureBytes({
      assets: ["tex-event", "tex-function", "tex-class", "tex-local", "tex-unused"].map((guid) => ({
        path: `assets/${guid}.texture.babasset`,
        header: {
          ...textureHeader([{
            id: "pixels",
            kind: "pixels",
            mime: "image/png",
            sha256: guid,
            locator: { inline: { offset: 0, length: 3 } },
          }], { width: 1, height: 1 }),
          guid,
        },
      })),
      guids: [],
      graphs: [
        { nodes: [parameterNode("event", "tex-event")], edges: [] },
        {
          nodes: [parameterNode("reused", "tex-event")],
          edges: [],
          members: [
            { id: "class-texture", kind: "variable", name: "Surface", typeId: "asset", typeClassId: "Texture", defaultValue: "tex-class" },
            { id: "local-textures", kind: "variable", name: "Choices", typeId: "asset", typeClassId: "Texture", container: "array", functionId: "applyAppearance", defaultValue: ["tex-local"] },
            { id: "ordinary-name", kind: "variable", name: "Name", typeId: "string", defaultValue: "tex-unused" },
          ],
          functionGraphs: {
            applyAppearance: {
              nodes: [parameterNode("function", "tex-function")],
              edges: [],
            },
          },
        },
      ],
      readChunk,
      editorLod: { enabled: false, quality: 1 },
    });
    expect(bytes).toEqual(new Map([
      ["tex-event", eventBytes],
      ["tex-function", functionBytes],
      ["tex-class", classBytes],
      ["tex-local", localBytes],
    ]));
  });

  it("downsamples source bytes when editor LOD wants a smaller edge", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const downsampled = new Uint8Array([4, 5]);
    const downsampleSource = vi.fn(async () => downsampled);
    const onMissingKtx2 = vi.fn();
    const bytes = await collectGpuTextureBytes({
      assets: [
        {
          path: "assets/Hero.texture.babasset",
          header: textureHeader(
            [
              {
                id: "pixels",
                kind: "pixels",
                mime: "image/png",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 3 } },
              },
            ],
            { usage: "albedo", width: 4096, height: 4096 },
          ),
        },
      ],
      guids: ["tex-1"],
      readChunk: async () => png,
      editorLod: { enabled: true, quality: 0.5 },
      downsampleSource,
      onMissingKtx2,
    });
    expect(bytes.get("tex-1")).toEqual(downsampled);
    expect(downsampleSource).toHaveBeenCalledWith(png, 2048);
    expect(onMissingKtx2).toHaveBeenCalledWith("tex-1");
  });

  it("keeps authored pixels when engine LOD is off", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const downsampleSource = vi.fn(async () => new Uint8Array([9]));
    const bytes = await collectGpuTextureBytes({
      assets: [
        {
          path: "assets/Hero.texture.babasset",
          header: textureHeader(
            [
              {
                id: "pixels",
                kind: "pixels",
                mime: "image/png",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 3 } },
              },
            ],
            { usage: "albedo", width: 4096, height: 4096 },
          ),
        },
      ],
      guids: ["tex-1"],
      readChunk: async () => png,
      editorLod: { enabled: false, quality: 0.5 },
      downsampleSource,
    });
    expect(bytes.get("tex-1")).toEqual(png);
    expect(downsampleSource).not.toHaveBeenCalled();
  });

  it("uses the stricter of engine LOD and per-texture downsample", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const downsampleSource = vi.fn(async () => new Uint8Array([8, 8]));
    await collectGpuTextureBytes({
      assets: [
        {
          path: "assets/Hero.texture.babasset",
          header: textureHeader(
            [
              {
                id: "pixels",
                kind: "pixels",
                mime: "image/png",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 3 } },
              },
            ],
            { usage: "albedo", downsample: 4, width: 4096, height: 4096 },
          ),
        },
      ],
      guids: ["tex-1"],
      readChunk: async () => png,
      editorLod: { enabled: true, quality: 0.5 },
      downsampleSource,
    });
    expect(downsampleSource).toHaveBeenCalledWith(png, 1024);
  });

  it("reads authored Texture payload size without using LOD GPU bytes", () => {
    const sizes = texturePixelSizesFromHeaders(
      [
        {
          path: "assets/Hero.texture.babasset",
          header: textureHeader(
            [
              {
                id: "pixels",
                kind: "pixels",
                mime: "image/png",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 3 } },
              },
            ],
            { usage: "albedo", width: 1024, height: 512 },
          ),
        },
      ],
      ["tex-1", "missing"],
    );
    expect(sizes.get("tex-1")).toEqual({ width: 1024, height: 512 });
    expect(sizes.has("missing")).toBe(false);
  });
});
