import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  inProcessPlayRuntimeOptions,
  playLoadControl,
  playPhysicsFromOpenDocuments,
} from "./play-physics";

const vendoredWasm = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/havok/HavokPhysics.wasm",
);

describe("playLoadControl", () => {
  it("forwards scene physics world, gravity, and the vendored Havok wasm URL", () => {
    const msg = playLoadControl({
      physicsWorld: "2d",
      gravity: [0, -20, 0],
    });
    expect(msg.type).toBe("load");
    expect(msg.sceneAssetGuid).toBe("play-scene");
    expect(msg.physicsWorld).toBe("2d");
    expect(msg.gravity).toEqual([0, -20, 0]);
    expect(msg.havokWasmUrl).toMatch(/\/havok\/HavokPhysics\.wasm$/);
  });

  it("defaults to a 3d world and standard gravity", () => {
    const msg = playLoadControl({});
    expect(msg.physicsWorld).toBe("3d");
    expect(msg.gravity).toEqual([0, -9.81, 0]);
    expect(msg.sceneAssetGuid).toBe("play-scene");
  });
});

describe("playPhysicsFromOpenDocuments", () => {
  it("reads physicsWorld and gravity from the active scene document", () => {
    expect(
      playPhysicsFromOpenDocuments(
        [
          {
            id: "scene:level",
            ref: { kind: "scene" },
            content: {
              settings: { physicsWorld: "2d", gravity: [0, -12, 0] },
            },
          },
        ],
        "scene:level",
      ),
    ).toEqual({
      physicsWorld: "2d",
      gravity: [0, -12, 0],
    });
  });

  it("falls back to the first open scene when the active tab is not a scene", () => {
    expect(
      playPhysicsFromOpenDocuments(
        [
          {
            id: "graph:main",
            ref: { kind: "graph" },
            content: {},
          },
          {
            id: "scene:level",
            ref: { kind: "scene" },
            content: {
              settings: { physicsWorld: "3d", gravity: [0, -9.81, 0] },
            },
          },
        ],
        "graph:main",
      ),
    ).toEqual({
      physicsWorld: "3d",
      gravity: [0, -9.81, 0],
    });
  });

  it("falls back to 3d defaults when no scene is open", () => {
    expect(playPhysicsFromOpenDocuments([], null)).toEqual({
      physicsWorld: "3d",
      gravity: [0, -9.81, 0],
    });
  });
});

describe("inProcessPlayRuntimeOptions", () => {
  it("includes the vendored Havok wasm URL so in-process Play does not stay on AABB", () => {
    const options = inProcessPlayRuntimeOptions({
      physicsWorld: "3d",
      gravity: [0, -9.81, 0],
    });
    expect(options.physicsWorld).toBe("3d");
    expect(options.gravity).toEqual([0, -9.81, 0]);
    expect(options.havokWasmUrl).toMatch(/\/havok\/HavokPhysics\.wasm$/);
  });
});

describe("vendored Havok wasm", () => {
  it("ships HavokPhysics.wasm under editor public/ for offline Play", () => {
    expect(existsSync(vendoredWasm)).toBe(true);
    const bytes = readFileSync(vendoredWasm);
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(bytes.byteLength).toBeGreaterThan(100_000);
  });
});
