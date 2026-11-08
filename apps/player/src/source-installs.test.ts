import { describe, expect, it } from "vitest";
import { assetBytesDigest, installedAssetIdentity } from "@haptic/assets";
import { fontMsdfAtlasExportGuid, type GameManifest } from "@haptic/exporter";
import { createPlayerSourceInstalls } from "./source-installs";

function game(assets: Array<{ guid: string; revision: string }>) {
  return {
    manifest: { assets: assets.map((entry) => ({ ...entry, type: "Texture", encoding: "bytes" })) } as unknown as GameManifest,
    textureBytes: new Map<string, Uint8Array>(),
    modelBytes: new Map<string, Uint8Array>(),
    fontMsdfPng: new Map<string, Uint8Array>(),
  };
}

describe("player source installs", () => {
  it("installs each held source once per catalog revision and reuses it for every later subset", async () => {
    const held = game([{ guid: "wall", revision: "rev-wall" }, { guid: "floor", revision: "rev-floor" }, { guid: "crate", revision: "rev-crate" }]);
    held.textureBytes.set("wall", new Uint8Array([1]));
    held.textureBytes.set("floor", new Uint8Array([2]));
    held.modelBytes.set("crate", new Uint8Array([3, 4]));
    const installs = createPlayerSourceInstalls(held);
    const startup = installs.textures(held.textureBytes);
    const subset = installs.textures(new Map([["floor", held.textureBytes.get("floor")!]]));
    expect([...subset.keys()]).toEqual(["floor"]);
    expect(subset.get("floor")).toBe(startup.get("floor"));
    expect([...new Uint8Array(await startup.get("wall")!.arrayBuffer())]).toEqual([1]);
    // A Texture's verified revision is its identity; a Model source, part of its payload, is hashed.
    expect(installedAssetIdentity(startup.get("wall")!)).toBe("rev-wall");
    const model = installs.models(held.modelBytes).get("crate")!;
    expect(installs.models(held.modelBytes).get("crate")).toBe(model);
    expect(installedAssetIdentity(model)).toBe(assetBytesDigest(new Uint8Array([3, 4])));
  });

  it("forgets a released source, so its next load installs again", () => {
    const held = game([{ guid: "wall", revision: "rev-wall" }, { guid: "floor", revision: "rev-floor" }]);
    held.textureBytes.set("wall", new Uint8Array([1]));
    const installs = createPlayerSourceInstalls(held);
    const first = installs.textures(held.textureBytes).get("wall");
    held.textureBytes.delete("wall");
    held.textureBytes.set("floor", new Uint8Array([2]));
    installs.textures(held.textureBytes);
    held.textureBytes.set("wall", new Uint8Array([1]));
    const reloaded = installs.textures(new Map([["wall", held.textureBytes.get("wall")!]])).get("wall");
    expect(reloaded).not.toBe(first);
    expect(installedAssetIdentity(reloaded!)).toBe("rev-wall");
  });

  it("keys a Font's MSDF atlas by its sidecar's revision", () => {
    const held = game([{ guid: fontMsdfAtlasExportGuid("ui"), revision: "rev-atlas" }]);
    held.fontMsdfPng.set("ui", new Uint8Array([5]));
    const installs = createPlayerSourceInstalls(held);
    const atlas = installs.msdfAtlases(held.fontMsdfPng).get("ui")!;
    expect(installs.msdfAtlases(held.fontMsdfPng).get("ui")).toBe(atlas);
    expect(installedAssetIdentity(atlas)).toBe("rev-atlas");
  });
});
