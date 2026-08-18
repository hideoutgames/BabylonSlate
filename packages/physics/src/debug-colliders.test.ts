import { describe, expect, it } from "vitest";
import { createSoftwarePhysicsBackend } from "./create-backend";
import {
  debugColliderFromDesc,
  listDebugCollidersFromRecords,
} from "./debug-colliders";

const identity = {
  position: { x: 1, y: 2, z: 3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};

describe("debugColliderFromDesc", () => {
  it("maps boxes, spheres, circles, and polylines and skips convex meshes", () => {
    expect(
      debugColliderFromDesc(
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
      debugColliderFromDesc(
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
      debugColliderFromDesc(
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
    ]);
    expect(
      debugColliderFromDesc(
        {
          id: "mesh",
          bodyId: "body",
          shape: { kind: "mesh", vertices: [], indices: [] },
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
