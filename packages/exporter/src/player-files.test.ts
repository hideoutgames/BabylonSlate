import { describe, expect, it } from "vitest";
import { selectPlayerRuntimeFiles } from "./player-files";

describe("selectPlayerRuntimeFiles", () => {
  it("keeps the standalone diagnostics entry only for explicit editor Preview", () => {
    const files = new Map([
      ["player.js", new Uint8Array([1])],
      ["player-preview-diagnostics.js", new Uint8Array([2])],
    ]);
    expect([...selectPlayerRuntimeFiles(files, { physicsWorld: "3d", platform: "web" }).keys()]).toEqual(["player.js"]);
    expect([...selectPlayerRuntimeFiles(files, { physicsWorld: "3d", platform: "web", includePreviewDiagnostics: true }).keys()])
      .toEqual(["player.js", "player-preview-diagnostics.js"]);
  });
  it("keeps Havok for 3d and Rapier for 2d", () => {
    const files = new Map([
      ["player.js", new Uint8Array([1])],
      ["havok/HavokPhysics.wasm", new Uint8Array([2])],
      ["assets/rapier.es.js", new Uint8Array([3])],
      ["havok/README.md", new Uint8Array([4])],
    ]);
    const three = selectPlayerRuntimeFiles(files, { physicsWorld: "3d", platform: "web" });
    expect([...three.keys()]).toEqual(["player.js", "havok/HavokPhysics.wasm"]);
    const two = selectPlayerRuntimeFiles(files, { physicsWorld: "2d", platform: "web" });
    expect([...two.keys()]).toEqual(["player.js", "assets/rapier.es.js"]);
  });
  it("keeps each platform module only for the platforms its condition names, and never ships the list", () => {
    const list = { "player-platform-desktop.js": "WITH_DESKTOP", "worker-platform-mobile.js": "WITH_MOBILE", "player-platform-not-linux.js": "!WITH_LINUX" };
    const files = new Map([
      ["player.js", new Uint8Array([1])],
      ["player-platform-desktop.js", new Uint8Array([2])],
      ["worker-platform-mobile.js", new Uint8Array([3])],
      ["player-platform-not-linux.js", new Uint8Array([4])],
      ["platform-modules.json", new TextEncoder().encode(JSON.stringify(list))],
    ]);
    const kept = (platform: "web" | "windows" | "linux" | "android") =>
      [...selectPlayerRuntimeFiles(files, { physicsWorld: "3d", platform }).keys()];
    expect(kept("web")).toEqual(["player.js", "player-platform-not-linux.js"]);
    expect(kept("windows")).toEqual(["player.js", "player-platform-desktop.js", "player-platform-not-linux.js"]);
    expect(kept("linux")).toEqual(["player.js", "player-platform-desktop.js"]);
    expect(kept("android")).toEqual(["player.js", "worker-platform-mobile.js", "player-platform-not-linux.js"]);
  });
  it("names a malformed platform module list", () => {
    const files = new Map([["platform-modules.json", new TextEncoder().encode(JSON.stringify({ "a.js": 1 }))]]);
    expect(() => selectPlayerRuntimeFiles(files, { physicsWorld: "3d", platform: "web" })).toThrow("platform-modules.json gives a.js no condition.");
  });
});
