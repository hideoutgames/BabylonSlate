import { describe, expect, it } from "vitest";
import { createActor, createDefaultSceneSettings } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

describe("runtime splines", () => {
  it("travels a Spline in world space through the actor and component transforms", async () => {
    const turn = Math.SQRT1_2;
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: { name: "Paths", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [
        createActor("rail", "Rail", { classId: "Rider",
          // A quarter turn about Y carries local +X onto world -Z.
          transform: { position: [10, 2, 0], rotation: [0, turn, 0, turn], scale: [1, 1, 1] },
          components: [{ id: "path", classId: "SplineComponent", parentId: null,
            transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] },
            properties: { points: [[0, 0, 0], [2, 0, 0]], curvature: 0, closed: false } }] }),
      ] } });
    try {
      await runtime.loadScripts([{ assetGuid: "rider", classId: "Rider", parentClassId: "Actor", anchors: [],
        entryPoints: [{ name: "Sample", event: "Sample", isAsync: false }],
        source: `
          export function Sample(ctx) {
            const path = ctx.getComponentById(ctx.self, "path");
            ctx.setVariable("length", ctx.callComponentFunction(path, "getSplineLength", {}).length);
            ctx.setVariable("inside", ctx.callComponentFunction(path, "getSplineLocationAtDistance", { distance: 1 }));
            ctx.setVariable("past", ctx.callComponentFunction(path, "getSplineLocationAtDistance", { distance: 9 }));
          }
        ` }]);
      runtime.realizePlayWorld(); runtime.start();
      const rail = runtime.getWorld().findActor("rail")!;
      runtime.invokeScriptEvent("Rider", "Sample", rail);
      expect(rail.getVariable("length")).toBeCloseTo(4, 6);
      const inside = rail.getVariable("inside") as { location: Record<string, number>; direction: Record<string, number> };
      expect(inside.location.x).toBeCloseTo(10, 6);
      expect(inside.location.y).toBeCloseTo(2, 6);
      expect(inside.location.z).toBeCloseTo(-2, 6);
      expect(inside.direction.z).toBeCloseTo(-1, 6);
      // An open path stops at its last point.
      expect((rail.getVariable("past") as typeof inside).location.z).toBeCloseTo(-5, 6);
    } finally { runtime.stop(); }
  });
});
