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
  it("clears errors and focus on document switches and ignores stale async publishers", () => {
    let current!: ReturnType<typeof useValidation>;
    function Probe() { current = useValidation(); return null; }
    const view = render(<ValidationProvider scopeKey="class-a"><Probe /></ValidationProvider>);
    const error = { ...pairingWarning("Invalid graph"), severity: "error" as const };
    act(() => { current.setDiagnostics([error]); current.setFocusDiagnostic(error); });
    expect(current.errorCount).toBe(1);
    const stale = current;
    view.rerender(<ValidationProvider scopeKey="material-b"><Probe /></ValidationProvider>);
    expect(current.errorCount).toBe(0);
    expect(current.focusDiagnostic).toBeNull();
    act(() => { stale.setDiagnostics([error]); stale.setFocusDiagnostic(error); });
    expect(current.diagnostics).toEqual([]);
    expect(current.focusDiagnostic).toBeNull();
    view.rerender(<ValidationProvider scopeKey="class-a"><Probe /></ValidationProvider>);
    act(() => stale.setDiagnostics([error]));
    expect(current.errorCount).toBe(0);
    act(() => current.setDiagnostics([error]));
    expect(current.errorCount).toBe(1);
  });

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
