import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Diagnostic } from "@babylonslate/scripting";
import { ValidationProvider, useValidation } from "./validation-context";

afterEach(() => {
  cleanup();
});

function pairingWarning(message: string): Diagnostic {
  return {
    severity: "warning",
    code: "physics.body_without_collider",
    message,
    assetGuid: "assets/Main.scene.babasset",
    graphId: "scene:assets/Main.scene.babasset",
    actorId: "hero",
    componentId: "rb",
  };
}

function renderValidation() {
  let current: ReturnType<typeof useValidation> | null = null;
  function Probe() {
    current = useValidation();
    return null;
  }
  render(
    <ValidationProvider>
      <Probe />
    </ValidationProvider>,
  );
  return () => current!;
}

describe("ValidationProvider", () => {
  it("keeps the published diagnostics when a panel recomputes an equal list", () => {
    const validation = renderValidation();
    act(() => validation().setDiagnostics([pairingWarning("Needs a collider.")]));
    const selected = validation().diagnostics[0]!;

    act(() => validation().setDiagnostics([pairingWarning("Needs a collider.")]));
    expect(validation().diagnostics).toContain(selected);

    act(() => validation().setDiagnostics([pairingWarning("Needs a box collider.")]));
    expect(validation().diagnostics).not.toContain(selected);
    expect(validation().diagnostics.map((entry) => entry.message)).toEqual([
      "Needs a box collider.",
    ]);
    act(() => validation().setDiagnostics([]));
    expect(validation().diagnostics).toEqual([]);
  });
});
