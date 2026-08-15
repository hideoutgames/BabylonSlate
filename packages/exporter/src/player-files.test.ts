import { describe, expect, it } from "vitest";
import { selectPlayerRuntimeFiles } from "./player-files";

describe("selectPlayerRuntimeFiles", () => {
  it("keeps Havok for 3d and Rapier for 2d", () => {
    const files = new Map([
      ["player.js", new Uint8Array([1])],
      ["havok/HavokPhysics.wasm", new Uint8Array([2])],
      ["assets/rapier.es.js", new Uint8Array([3])],
      ["havok/README.md", new Uint8Array([4])],
    ]);
    const three = selectPlayerRuntimeFiles(files, { physicsWorld: "3d" });
    expect([...three.keys()]).toEqual(["player.js", "havok/HavokPhysics.wasm"]);
    const two = selectPlayerRuntimeFiles(files, { physicsWorld: "2d" });
    expect([...two.keys()]).toEqual(["player.js", "assets/rapier.es.js"]);
  });
});
