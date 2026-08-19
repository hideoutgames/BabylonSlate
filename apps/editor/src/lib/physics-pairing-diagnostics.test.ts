import { describe, expect, it } from "vitest";
import { physicsPairingDiagnostics } from "./physics-pairing-diagnostics";

describe("physicsPairingDiagnostics", () => {
  it("maps pairing warnings onto Compiler Results diagnostics", () => {
    const rows = physicsPairingDiagnostics(
      [
        {
          id: "hero",
          components: [{ id: "rb", classId: "RigidBodyComponent" }],
        },
      ],
      { assetGuid: "assets/Main.scene.babasset", graphId: "scene:main" },
    );
    expect(rows).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "physics.body_without_collider",
        assetGuid: "assets/Main.scene.babasset",
        graphId: "scene:main",
        actorId: "hero",
        componentId: "rb",
      }),
    ]);
  });
});
