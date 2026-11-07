import { afterEach, describe, expect, it, vi } from "vitest";
import { createPhysicsBackend } from "./create-backend";
import { HavokPhysicsBackend } from "./havok-backend";
import { Rapier2DPhysicsBackend } from "./rapier-backend";

afterEach(() => vi.restoreAllMocks());

describe("physics backend initialization failures", () => {
  it.each(["3d", "2d"] as const)(
    "rejects unavailable %s physics instead of falling back to software",
    async (kind) => {
      const unavailable = new Error("Physics engine unavailable");
      vi.spyOn(HavokPhysicsBackend, "create").mockRejectedValue(unavailable);
      vi.spyOn(Rapier2DPhysicsBackend, "create").mockRejectedValue(unavailable);

      await expect(
        createPhysicsBackend({
          kind,
          gravity: { x: 0, y: -9.81, z: 0 },
        }),
      ).rejects.toThrow("Physics engine unavailable");
    },
  );
});
