import { describe, expect, it } from "vitest";
import { colliderLocalPose, scaleColliderShape } from "./collider-bake";
import { prepareColliderShape } from "./collider-validation";
import { HavokPhysicsBackend } from "./havok-backend";
import { SoftwarePhysicsBackend } from "./software-backend";
import type { ColliderDesc, HeightFieldColliderShape, PhysicsTransform } from "./types";

const pose = (x = 0, y = 0, z = 0): PhysicsTransform => ({
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
});

function createHeightFieldCollider(
  bodyId: string,
  shape: HeightFieldColliderShape,
  id = `${bodyId}:hf`,
): ColliderDesc {
  return {
    id,
    bodyId,
    shape,
    friction: 0.6,
    restitution: 0,
    isTrigger: false,
    layer: 1,
    mask: 0xffffffff,
  };
}

describe("HeightFieldColliderShape (Havok & Software)", () => {
  it("aligns X-major transposition, centering, and (1,0)-(0,1) diagonal split in Havok", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    try {
      // 2x2 cell grid (3x3 samples) spanning [-10, +10] in X and [-6, +6] in Z.
      // Asymmetric heights so X/Z transposition bugs or missing centering are immediately caught.
      // Z-major layout: heights[iz * numXSamples + ix]
      const heights = new Float32Array([
        // iz = 0 (z = -6): x = -10, 0, +10
        1, 2, 5,
        // iz = 1 (z = 0): x = -10, 0, +10
        3, 6, 4,
        // iz = 2 (z = +6): x = -10, 0, +10
        7, 8, 2,
      ]);
      const shape: HeightFieldColliderShape = {
        kind: "heightfield",
        numXSamples: 3,
        numZSamples: 3,
        width: 20,
        depth: 12,
        heights,
      };
      backend.createBody({
        id: "terrain",
        actorId: "terrain",
        motionType: "static",
        mass: 0,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 0,
        transform: pose(0, 0, 0),
      });
      backend.createCollider(createHeightFieldCollider("terrain", shape));

      // Verify exact corner/interior samples (slightly inset from outer border to avoid edge graze).
      const probe = (x: number, z: number) =>
        backend.lineTrace({ x, y: 20, z }, { x, y: -10, z });

      // Near (-10, -6) -> h00 = 1
      expect(probe(-9.9, -5.9).location?.y).toBeCloseTo(1, 1);
      // Near (+10, -6) -> h20 = 5
      expect(probe(9.9, -5.9).location?.y).toBeCloseTo(5, 1);
      // Near (-10, +6) -> h02 = 7
      expect(probe(-9.9, 5.9).location?.y).toBeCloseTo(7, 1);
      // Center (0, 0) -> h11 = 6
      expect(probe(0, 0).location?.y).toBeCloseTo(6, 2);

      // Verify quad diagonal split on cell (ix=0, iz=0), spanning x in [-10, 0], z in [-6, 0]:
      // Corners: (0,0)=1, (1,0)=2, (0,1)=3, (1,1)=6.
      // Diagonal (1,0)-(0,1) gives midpoint height (2 + 3) / 2 = 2.5
      // (whereas diagonal (0,0)-(1,1) would give (1 + 6) / 2 = 3.5).
      const midHit = probe(-5, -3);
      expect(midHit.hit).toBe(true);
      expect(midHit.location?.y).toBeCloseTo(2.5, 2);

      // Outside footprint should miss.
      expect(probe(12, 0).hit).toBe(false);
      expect(probe(0, 8).hit).toBe(false);
    } finally {
      backend.dispose();
    }
  });

  it("supports dynamic sphere landing and character controller walking on a sloped heightfield", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -20, z: 0 } });
    try {
      const side = 17;
      const heights = new Float32Array(side * side);
      for (let iz = 0; iz < side; iz++) {
        for (let ix = 0; ix < side; ix++) {
          const x = -16 + (ix / (side - 1)) * 32;
          // Gentle ramp rising along +X: y = 2 + 0.15 * x
          heights[iz * side + ix] = 2 + 0.15 * x;
        }
      }
      backend.createBody({
        id: "terrain",
        actorId: "terrain",
        motionType: "static",
        mass: 0,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 0,
        transform: pose(0, 0, 0),
      });
      backend.createCollider(createHeightFieldCollider("terrain", {
        kind: "heightfield",
        numXSamples: side,
        numZSamples: side,
        width: 32,
        depth: 32,
        heights,
      }));

      // Dynamic sphere dropped at x = 4 (terrain y = 2.6, sphere radius = 0.5 -> rest y ~ 3.1).
      backend.createBody({
        id: "ball",
        actorId: "ball",
        motionType: "dynamic",
        mass: 1,
        linearDamping: 0.4,
        angularDamping: 0.4,
        gravityScale: 1,
        transform: pose(4, 6, 0),
      });
      backend.createCollider({
        id: "ball:sphere",
        bodyId: "ball",
        shape: { kind: "sphere", radius: 0.5 },
        friction: 0.9,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 0xffffffff,
      });

      // Capsule character walking uphill along +X from x = 0 (terrain y = 2.0) to x = 4 (terrain y = 2.6).
      backend.createBody({
        id: "hero",
        actorId: "hero",
        motionType: "kinematic",
        mass: 1,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 0,
        transform: pose(0, 3.0, 4),
      });
      backend.createCollider({
        id: "hero:capsule",
        bodyId: "hero",
        shape: { kind: "capsule", radius: 0.35, halfHeight: 0.55 },
        friction: 0.5,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 0xffffffff,
      });
      backend.createCharacterController({
        id: "hero:cc",
        bodyId: "hero",
        offset: 0.02,
        radius: 0.35,
        height: 1.8,
        maxSlopeAngle: 60,
        groundSnapDistance: 0.2,
      });

      let lastMove = null;
      for (let i = 0; i < 60; i++) {
        lastMove = backend.moveCharacter("hero:cc", { x: 4 / 60, y: -0.03, z: 0 }, 1 / 60);
        backend.step(1 / 60);
      }

      const ballPose = backend.getBodyTransform("ball")!;
      // Ball landed on the ramp and did not tunnel through.
      const expectedBallTerrainY = 2 + 0.15 * ballPose.position.x;
      expect(ballPose.position.y).toBeGreaterThan(expectedBallTerrainY + 0.35);
      expect(ballPose.position.y).toBeLessThan(expectedBallTerrainY + 0.85);

      // Character walked uphill and stayed grounded above the ramp surface.
      expect(lastMove?.grounded).toBe(true);
      expect(lastMove!.position.x).toBeGreaterThan(3.0);
      const expectedHeroTerrainY = 2 + 0.15 * lastMove!.position.x;
      expect(lastMove!.position.y).toBeGreaterThan(expectedHeroTerrainY + 0.75);
      expect(lastMove!.position.y).toBeLessThan(expectedHeroTerrainY + 1.25);
    } finally {
      backend.dispose();
    }
  });

  it("scales non-uniformly and flips height samples on negative scale", () => {
    const heights = new Float32Array([
      1, 2,
      3, 4,
    ]);
    const base: HeightFieldColliderShape = {
      kind: "heightfield",
      numXSamples: 2,
      numZSamples: 2,
      width: 10,
      depth: 8,
      heights,
    };

    // Positive unit Y scale reuses heights buffer with zero copy.
    const stretchedXZ = scaleColliderShape(base, { x: 2, y: 1, z: 3 }) as HeightFieldColliderShape;
    expect(stretchedXZ.width).toBe(20);
    expect(stretchedXZ.depth).toBe(24);
    expect(stretchedXZ.heights).toBe(heights);

    // Negative X and Z (a half turn) reverse both axes and scale heights.
    const turned = scaleColliderShape(base, { x: -1, y: 2, z: -1 }) as HeightFieldColliderShape;
    expect(Array.from(turned.heights)).toEqual([8, 6, 4, 2]);

    // One mirrored axis would flip the cells' diagonal: the pose must fold it first.
    expect(() => scaleColliderShape(base, { x: -1, y: 1, z: 1 })).toThrow("foldHeightFieldMirror");
    expect(() => scaleColliderShape(base, { x: 1, y: 1, z: -1 })).toThrow("foldHeightFieldMirror");
  });

  describe.each([
    { title: "mirrored on X", actorScale: { x: -1, y: 1, z: 1 } },
    { title: "mirrored on Z", actorScale: { x: 1, y: 1, z: -1 } },
    { title: "mirrored on X and Z", actorScale: { x: -1.5, y: 2, z: -1 } },
    { title: "mirrored on X and upside down", actorScale: { x: -1, y: -1, z: 1 } },
  ])("a terrain $title", ({ actorScale }) => {
    // 3 x 3 samples over 20 x 12, asymmetric so a flipped diagonal, axis or height shows.
    const source: HeightFieldColliderShape = {
      kind: "heightfield", numXSamples: 3, numZSamples: 3, width: 20, depth: 12,
      heights: new Float32Array([1, 2, 5, 3, 6, 4, 7, 8, 2]),
    };
    /** The drawn surface's world height over (x, z): the landscape mesh splits each cell along local (1,0)–(0,1). */
    const drawnHeight = (x: number, z: number) => {
      const fx = (x / actorScale.x + 10) / 10;
      const fz = (z / actorScale.z + 6) / 6;
      const ix = Math.min(1, Math.floor(fx));
      const iz = Math.min(1, Math.floor(fz));
      const u = fx - ix;
      const v = fz - iz;
      const at = (dx: number, dz: number) => source.heights[(iz + dz) * 3 + ix + dx]!;
      const local = u + v <= 1
        ? at(0, 0) + u * (at(1, 0) - at(0, 0)) + v * (at(0, 1) - at(0, 0))
        : at(1, 1) + (1 - u) * (at(0, 1) - at(1, 1)) + (1 - v) * (at(1, 0) - at(1, 1));
      return local * actorScale.y;
    };
    // Points across each cell, both sides of either diagonal.
    const probes = [-7.5, -2.5, 2.5, 7.5].flatMap((x) => [-4.5, -1.5, 1.5, 4.5].map((z) => ({ x: x * Math.abs(actorScale.x), z: z * Math.abs(actorScale.z) })));
    /** The terrain's static body, its collider posed and scaled as runtime physics bakes an actor's scale. */
    const build = (backend: HavokPhysicsBackend | SoftwarePhysicsBackend) => {
      const attachment = colliderLocalPose("heightfield", { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }, actorScale);
      backend.createBody({
        id: "terrain", actorId: "terrain", motionType: "static", mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0,
        transform: pose(0, 0, 0),
      });
      const shape = prepareColliderShape(scaleColliderShape(source, attachment.scale)) as HeightFieldColliderShape;
      backend.createCollider({ ...createHeightFieldCollider("terrain", shape), rotation: attachment.rotation, translation: attachment.translation });
    };
    const probe = (backend: HavokPhysicsBackend | SoftwarePhysicsBackend) => probes.map(({ x, z }) => {
      // From the side the surface faces, so an upside-down terrain is traced from below.
      const up = actorScale.y < 0 ? -1 : 1;
      const hit = backend.lineTrace({ x, y: 40 * up, z }, { x, y: -40 * up, z });
      return { x, z, y: hit.location?.y ?? null, expected: drawnHeight(x, z) };
    });

    it("collides with Havok on the triangles it draws", async () => {
      const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
      try {
        build(backend);
        for (const { y, expected } of probe(backend)) expect(y).toBeCloseTo(expected, 3);
      } finally { backend.dispose(); }
    });

    it("traces the software backend on the triangles it draws", () => {
      const backend = new SoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
      try {
        build(backend);
        for (const { y, expected } of probe(backend)) expect(y).toBeCloseTo(expected, 3);
      } finally { backend.dispose(); }
    });
  });

  it("rejects invalid heightfields during validation", () => {
    expect(() =>
      prepareColliderShape({
        kind: "heightfield",
        numXSamples: 1,
        numZSamples: 2,
        width: 10,
        depth: 10,
        heights: new Float32Array([0, 0]),
      }),
    ).toThrow(/Invalid heightfield collider/);

    expect(() =>
      prepareColliderShape({
        kind: "heightfield",
        numXSamples: 2,
        numZSamples: 2,
        width: 10,
        depth: 10,
        heights: new Float32Array([0, 1, 2]),
      }),
    ).toThrow(/Invalid heightfield collider/);

    expect(() =>
      prepareColliderShape({
        kind: "heightfield",
        numXSamples: 2,
        numZSamples: 2,
        width: 10,
        depth: 10,
        heights: new Float32Array([0, Number.NaN, 0, 0]),
      }),
    ).toThrow(/Invalid heightfield collider/);
  });

  it("traces exact heightfield cells in SoftwarePhysicsBackend and exposes cached debug wireframes", () => {
    const backend = new SoftwarePhysicsBackend("3d", { x: 0, y: -9.81, z: 0 });
    try {
      // High peak at (0, 0) = 10, valley at (+10, +10) = 0.
      const heights = new Float32Array([
        10, 0, 0,
        0, 0, 0,
        0, 0, 0,
      ]);
      const shape: HeightFieldColliderShape = {
        kind: "heightfield",
        numXSamples: 3,
        numZSamples: 3,
        width: 20,
        depth: 20,
        heights,
      };
      backend.createBody({
        id: "terrain",
        actorId: "terrain",
        motionType: "static",
        mass: 0,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 0,
        transform: pose(0, 0, 0),
      });
      backend.createCollider(createHeightFieldCollider("terrain", shape));

      // Ray over the valley should hit y = 0, NOT the AABB ceiling at y = 10.
      const valleyHit = backend.lineTrace({ x: 5, y: 20, z: 5 }, { x: 5, y: -5, z: 5 });
      expect(valleyHit.hit).toBe(true);
      expect(valleyHit.location?.y).toBeCloseTo(0, 4);

      // Ray over cell (0,0) center (-5, -5) uses diagonal (1,0)-(0,1) -> (0 + 0) / 2 = 0.
      const diagHit = backend.lineTrace({ x: -5, y: 20, z: -5 }, { x: -5, y: -5, z: -5 });
      expect(diagHit.hit).toBe(true);
      expect(diagHit.location?.y).toBeCloseTo(0, 4);

      // Ray near peak (-9, -9) should hit near y = 8.
      const peakHit = backend.lineTrace({ x: -9, y: 20, z: -9 }, { x: -9, y: -5, z: -9 });
      expect(peakHit.hit).toBe(true);
      expect(peakHit.location?.y).toBeCloseTo(8, 3);

      // Debug collider expands to mesh wireframe and reuses cached arrays.
      const first = backend.listDebugColliders();
      const second = backend.listDebugColliders();
      expect(first).toHaveLength(1);
      expect(first[0]!.shape).toBe("mesh");
      expect(first[0]!.points).toHaveLength(9);
      expect(first[0]!.indices).toHaveLength(24);
      expect(second[0]!.points).toBe(first[0]!.points);
    } finally {
      backend.dispose();
    }
  });

  it("reclaims native Havok heightfield shapes without leaking on replace and destroyBody", async () => {
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: 0, z: 0 } });
    try {
      const baseline = backend.havok.HP_GetStatistics()[1][1];
      backend.createBody({
        id: "terrain",
        actorId: "terrain",
        motionType: "static",
        mass: 0,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 0,
        transform: pose(0, 0, 0),
      });
      backend.createCollider(createHeightFieldCollider("terrain", {
        kind: "heightfield",
        numXSamples: 5,
        numZSamples: 5,
        width: 16,
        depth: 16,
        heights: new Float32Array(25),
      }));
      expect(backend.havok.HP_GetStatistics()[1][1]).toBe(baseline + 1);

      // Replace heightfield via upsert.
      const raised = new Float32Array(25).fill(3);
      backend.applyColliderChanges("terrain", {
        upsert: [createHeightFieldCollider("terrain", {
          kind: "heightfield",
          numXSamples: 5,
          numZSamples: 5,
          width: 16,
          depth: 16,
          heights: raised,
        })],
        remove: [],
      });
      expect(backend.havok.HP_GetStatistics()[1][1]).toBe(baseline + 1);

      backend.destroyBody("terrain");
      expect(backend.havok.HP_GetStatistics()[1][1]).toBe(baseline);
    } finally {
      backend.dispose();
    }
  });
});
