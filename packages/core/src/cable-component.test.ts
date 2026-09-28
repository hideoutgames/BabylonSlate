import { describe, expect, it } from "vitest";
import { parseCableProperties } from "./cable-component";

describe("cable properties", () => {
  it("bounds authored work and physical parameters before buffers or steps are created", () => {
    expect(parseCableProperties({
      cableLength: -1, numSegments: 100000, cableWidth: 0, numSides: 2,
      tileMaterial: 1e9, solverIterations: 1e9, gravityScale: -1e9,
      damping: 2, substepTime: 0, maxSubsteps: 0,
      collisionFriction: -1, sleepThreshold: -1, sleepDelay: 100,
      cableForce: [1e100, -1e100, 7], endPosition: [3, Infinity, 0],
    })).toMatchObject({
      cableLength: 0.01, numSegments: 64, cableWidth: 0.001, numSides: 3,
      tileMaterial: 1000, solverIterations: 16, gravityScale: -100,
      damping: 1, substepTime: 1 / 120, maxSubsteps: 1,
      collisionFriction: 0, sleepThreshold: 0, sleepDelay: 10,
      cableForce: [1e6, -1e6, 7], endPosition: [3, 0, 0],
    });
    expect(parseCableProperties({ numSegments: 3.8, numSides: 5.2, substepTime: NaN, cableLength: Infinity }))
      .toMatchObject({ numSegments: 4, numSides: 5, substepTime: 1 / 60, cableLength: 4 });
  });

  it("preserves valid attachments and gives malformed serialized fields safe independent defaults", () => {
    expect(parseCableProperties({
      enabled: false, materialGuid: "metal", targetActorId: "crane", targetComponentId: "hook",
      attachStart: false, attachEnd: false, endPosition: [1, 2, 3],
      enableCollision: true, enableStiffness: true,
    })).toMatchObject({
      enabled: false, materialGuid: "metal", targetActorId: "crane", targetComponentId: "hook",
      attachStart: false, attachEnd: false, endPosition: [1, 2, 3],
      enableCollision: true, enableStiffness: true,
    });
    const invalid = parseCableProperties({ materialGuid: 3, targetActorId: "", targetComponentId: {}, cableForce: [1, "2", 3], enableCollision: "true" });
    expect(invalid).toMatchObject({ materialGuid: null, targetActorId: null, targetComponentId: null, cableForce: [0, 0, 0], enableCollision: false });
    invalid.cableForce[0] = 4;
    invalid.endPosition[0] = 4;
    expect(parseCableProperties(null)).toMatchObject({ cableForce: [0, 0, 0], endPosition: [3, 0, 0] });
  });

  it("accepts script Vector3 values alongside serialized triples", () => {
    expect(parseCableProperties({ endPosition: { x: 2, y: 1, z: 0 }, cableForce: { x: 1, y: -2, z: 3 } }))
      .toMatchObject({ endPosition: [2, 1, 0], cableForce: [1, -2, 3] });
    expect(parseCableProperties({ endPosition: { x: 2, y: 1 }, cableForce: { x: 1, y: Infinity, z: 3 } }))
      .toMatchObject({ endPosition: [3, 0, 0], cableForce: [0, 0, 0] });
  });
});
