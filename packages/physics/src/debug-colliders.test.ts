import { describe, expect, it } from "vitest";
import { createSoftwarePhysicsBackend } from "./create-backend";
import {
  listDebugCollidersFromRecords,
} from "./debug-colliders";
import type { ColliderDesc, PhysicsTransform } from "./types";

const identity = {
  position: { x: 1, y: 2, z: 3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};

const describeOne = (desc: ColliderDesc, transform: PhysicsTransform) =>
  listDebugCollidersFromRecords([{ desc }], () => transform)[0] ?? null;

describe("debug collider shapes", () => {
  it("maps the simulation shape and closes polygon outlines", () => {
    expect(
      describeOne(
        {
          id: "box",
          bodyId: "body",
          shape: { kind: "box", halfExtents: { x: 0.5, y: 1, z: 1.5 } },
          friction: 0,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
        identity,
      ),
    ).toMatchObject({
      id: "box",
      shape: "box",
      position: identity.position,
      halfExtents: { x: 0.5, y: 1, z: 1.5 },
    });
    expect(
      describeOne(
        {
          id: "circle",
          bodyId: "body",
          shape: { kind: "circle", radius: 2 },
          friction: 0,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
        identity,
      )?.shape,
    ).toBe("circle");
    expect(
      describeOne(
        {
          id: "poly",
          bodyId: "body",
          shape: {
            kind: "polygon",
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 0, y: 1 },
            ],
          },
          friction: 0,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
        identity,
      )?.points,
    ).toEqual([
      { x: 1, y: 2, z: 3 },
      { x: 2, y: 2, z: 3 },
      { x: 1, y: 3, z: 3 },
      { x: 1, y: 2, z: 3 },
    ]);
    expect(
      describeOne(
        {
          id: "capsule",
          bodyId: "body",
          shape: { kind: "capsule", radius: 0.5, halfHeight: 1 },
          friction: 0,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
        identity,
      ),
    ).toMatchObject({
      id: "capsule",
      shape: "capsule",
      position: identity.position,
      radius: 0.5,
      halfHeight: 1,
    });
    expect(
      describeOne(
        {
          id: "capsule2d",
          bodyId: "body",
          shape: { kind: "capsule2d", radius: 0.4, halfHeight: 0.8 },
          friction: 0,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
        identity,
      ),
    ).toMatchObject({
      shape: "capsule2d",
      radius: 0.4,
      halfHeight: 0.8,
    });
    expect(
      describeOne(
        {
          id: "cylinder",
          bodyId: "body",
          shape: { kind: "cylinder", radius: 0.5, height: 2 },
          friction: 0,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
        identity,
      ),
    ).toMatchObject({
      shape: "cylinder",
      radius: 0.5,
      height: 2,
    });
    expect(
      describeOne(
        {
          id: "mesh",
          bodyId: "body",
          shape: { kind: "mesh", positions: new Float32Array(), indices: new Uint16Array() },
          friction: 0,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
        identity,
      ),
    ).toBeNull();
    expect(
      describeOne(
        {
          id: "hull",
          bodyId: "body",
          shape: {
            kind: "convex",
            points: [
              { x: 0, y: 0, z: 0 },
              { x: 1, y: 0, z: 0 },
              { x: 0, y: 1, z: 0 },
              { x: 0, y: 0, z: 1 },
            ],
          },
          friction: 0,
          restitution: 0,
          isTrigger: false,
          layer: 1,
          mask: 1,
        },
        identity,
      ),
    ).toMatchObject({
      id: "hull",
      shape: "convex",
      position: identity.position,
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
      ],
    });
    expect(
      listDebugCollidersFromRecords(
        [
          {
            desc: {
              id: "orphan",
              bodyId: "missing",
              shape: { kind: "sphere", radius: 1 },
              friction: 0,
              restitution: 0,
              isTrigger: false,
              layer: 1,
              mask: 1,
            },
          },
        ],
        () => null,
      ),
    ).toEqual([]);
  });

  it("retains triangle geometry and pose for mesh collision debugging", () => {
    const listed = describeOne({
      id: "triangle", bodyId: "body",
      shape: { kind: "mesh", positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]), indices: new Uint16Array([0, 1, 2]) },
      friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 1,
    }, identity);
    expect(listed).toMatchObject({
      shape: "mesh", position: { x: 1, y: 2, z: 3 },
      points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }], indices: [0, 1, 2],
    });
  });

  it("closes looped chains while retaining open chains", () => {
    const desc = {
      id: "chain", bodyId: "body",
      shape: { kind: "chain" as const, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }] },
      friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 1,
    };
    expect(describeOne(desc, identity)?.points).toHaveLength(3);
    expect(describeOne({ ...desc, shape: { ...desc.shape, loop: true } }, identity)?.points).toEqual([
      { x: 1, y: 2, z: 3 }, { x: 3, y: 2, z: 3 }, { x: 3, y: 4, z: 3 }, { x: 1, y: 2, z: 3 },
    ]);
  });
});

describe("SoftwarePhysicsBackend.listDebugColliders", () => {
  it("lists live collider primitives in world space", () => {
    const backend = createSoftwarePhysicsBackend("3d", {
      x: 0,
      y: 0,
      z: 0,
    });
    backend.createBody({
      id: "body",
      actorId: "actor",
      motionType: "static",
      mass: 0,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      transform: identity,
    });
    backend.createCollider({
      id: "col",
      bodyId: "body",
      shape: { kind: "sphere", radius: 0.25 },
      friction: 0,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 1,
      translation: { x: 0, y: 4, z: 0 },
    });
    expect(backend.listDebugColliders()).toEqual([
      {
        id: "col",
        shape: "sphere",
        position: { x: 1, y: 6, z: 3 },
        rotation: identity.rotation,
        radius: 0.25,
      },
    ]);
    backend.dispose();
  });
});

describe("SoftwarePhysicsBackend.listDebugColliders point shapes", () => {
  const base = { friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 1 };
  const hull = (scale: number) => ({
    kind: "convex" as const,
    points: [
      { x: 0, y: 0, z: 0 }, { x: scale, y: 0, z: 0 }, { x: 0, y: scale, z: 0 }, { x: 0, y: 0, z: scale },
    ],
  });
  const triangle = (size: number) => ({
    kind: "mesh" as const,
    positions: new Float32Array([0, 0, 0, size, 0, 0, 0, size, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });

  it("follows the body pose and a replaced shape without altering earlier listings", () => {
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    backend.createBody({
      id: "body", actorId: "actor", motionType: "static", mass: 0, linearDamping: 0,
      angularDamping: 0, gravityScale: 0, transform: identity,
    });
    backend.createCollider({ ...base, id: "hull", bodyId: "body", shape: hull(1) });
    backend.createCollider({ ...base, id: "tri", bodyId: "body", shape: triangle(2) });
    const before = backend.listDebugColliders();
    expect(before.map((entry) => entry.points?.[1])).toEqual([{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]);

    backend.teleportBody("body", { position: { x: 5, y: 0, z: 0 }, rotation: identity.rotation });
    const moved = backend.listDebugColliders();
    expect(moved.map((entry) => entry.position.x)).toEqual([5, 5]);
    expect(moved.map((entry) => entry.points)).toEqual(before.map((entry) => entry.points));
    expect(moved[1]?.indices).toEqual([0, 1, 2]);

    backend.applyColliderChanges("body", {
      upsert: [{ ...base, id: "hull", bodyId: "body", shape: hull(3) }, { ...base, id: "tri", bodyId: "body", shape: triangle(4) }],
      remove: [],
    });
    const replaced = backend.listDebugColliders();
    expect(replaced.map((entry) => entry.points?.[1])).toEqual([{ x: 3, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }]);
    expect(replaced.map((entry) => entry.position.x)).toEqual([5, 5]);
    expect(before.map((entry) => entry.points?.[1])).toEqual([{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]);
    backend.dispose();
  });
});

describe("debug collider world pose", () => {
  it("rotates the local collider offset by the body quaternion", () => {
    const yaw90 = Math.SQRT1_2;
    const listed = describeOne(
      {
        id: "offset-box",
        bodyId: "body",
        shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        friction: 0,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 1,
        translation: { x: 1, y: 0, z: 0 },
      },
      {
        position: { x: 10, y: 0, z: 0 },
        rotation: { x: 0, y: yaw90, z: 0, w: yaw90 },
      },
    );
    expect(listed?.position.x).toBeCloseTo(10);
    expect(listed?.position.y).toBeCloseTo(0);
    expect(listed?.position.z).toBeCloseTo(-1);
  });

  it("rotates polyline points into world space", () => {
    const yaw90 = Math.SQRT1_2;
    const listed = describeOne(
      {
        id: "poly",
        bodyId: "body",
        shape: {
          kind: "polygon",
          points: [
            { x: 1, y: 0 },
            { x: 0, y: 0 },
            { x: 0, y: 1 },
          ],
        },
        friction: 0,
        restitution: 0,
        isTrigger: false,
        layer: 1,
        mask: 1,
      },
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: yaw90, z: 0, w: yaw90 },
      },
    );
    expect(listed?.points?.[0]?.x).toBeCloseTo(0);
    expect(listed?.points?.[0]?.z).toBeCloseTo(-1);
    expect(listed?.points?.[2]?.x).toBeCloseTo(0);
    expect(listed?.points?.[2]?.y).toBeCloseTo(1);
    expect(listed?.points?.[2]?.z).toBeCloseTo(0);
  });
});
