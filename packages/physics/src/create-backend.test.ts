import { afterEach, describe, expect, it, vi } from "vitest";
import { createPhysicsBackend } from "./create-backend";
import { HavokPhysicsBackend } from "./havok-backend";
import { Rapier2DPhysicsBackend } from "./rapier-backend";
import { SoftwarePhysicsBackend } from "./software-backend";

afterEach(() => vi.restoreAllMocks());

describe("physics backend initialization failures", () => {
  it.each(["3d", "2d"] as const)(
    "rejects unavailable %s physics when accurate simulation is required",
    async (kind) => {
      const unavailable = new Error("Physics engine unavailable");
      vi.spyOn(HavokPhysicsBackend, "create").mockRejectedValue(unavailable);
      vi.spyOn(Rapier2DPhysicsBackend, "create").mockRejectedValue(unavailable);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        createPhysicsBackend({
          kind,
          gravity: { x: 0, y: -9.81, z: 0 },
          allowSoftwareFallback: false,
        }),
      ).rejects.toThrow("Physics engine unavailable");
    },
  );

  it("retains the software fallback for callers that permit it", async () => {
    vi.spyOn(HavokPhysicsBackend, "create").mockRejectedValue(
      new Error("Offline"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = await createPhysicsBackend({
      kind: "3d",
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    try {
      expect(backend).toBeInstanceOf(SoftwarePhysicsBackend);
    } finally {
      backend.dispose();
    }
  });
});
