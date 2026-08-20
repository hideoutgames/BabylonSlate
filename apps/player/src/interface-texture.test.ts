import { describe, expect, it } from "vitest";
import { resolvePlayerInterfaceTexture } from "./interface-texture";

describe("resolvePlayerInterfaceTexture", () => {
  it("loads Interface GPU textures with invertY false so they share the scene sampling key", () => {
    const sampling: unknown[] = [];
    const cache = {
      getTexture: (
        _guid: string,
        _engine: unknown,
        _bytes: Uint8Array,
        options?: { invertY?: boolean },
      ) => {
        sampling.push(options);
        return { isCube: false, invertY: options?.invertY === false ? false : true };
      },
    };
    const texture = resolvePlayerInterfaceTexture(
      cache as never,
      {} as never,
      "tex-1",
      new Uint8Array([1, 2, 3]),
    );
    expect(sampling).toEqual([{ invertY: false }]);
    expect(texture).not.toBeNull();
    expect(texture!.invertY).toBe(false);
  });
});
