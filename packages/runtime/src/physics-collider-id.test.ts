import { describe, expect, it } from "vitest";
import {
  componentColliderPhysicsId,
  componentIdFromColliderPhysicsId,
} from "./physics-collider-id";

describe("physics collider identities", () => {
  it("separates actor and component IDs containing delimiters without losing script bindings", () => {
    const first = componentColliderPhysicsId("actor:part", "sensor");
    const second = componentColliderPhysicsId("actor", "part:sensor");
    expect(first).not.toBe(second);
    expect(componentIdFromColliderPhysicsId(first)).toBe("sensor");
    expect(componentIdFromColliderPhysicsId(second)).toBe("part:sensor");
    const mesh = componentColliderPhysicsId(
      "actor:part",
      "mesh:part",
      "hull:1",
    );
    expect(componentIdFromColliderPhysicsId(mesh)).toBe("mesh:part");
    expect(mesh).not.toBe(
      componentColliderPhysicsId("actor:part", "mesh:part", "hull:2"),
    );
  });

  it("keeps the ID of a collider that no component owns", () => {
    expect(componentIdFromColliderPhysicsId("tilemap:actor:layer")).toBe(
      "tilemap:actor:layer",
    );
    expect(componentIdFromColliderPhysicsId(undefined)).toBeUndefined();
  });
});
