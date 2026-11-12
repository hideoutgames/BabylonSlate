import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Diagnostic } from "@haptic/scripting";
import { ValidationProvider, useValidation } from "./validation-context";

afterEach(() => {
  cleanup();
});

function pairingWarning(message: string): Diagnostic {
  return {
    severity: "warning",
    code: "physics.body_without_collider",
    message,
    assetGuid: "assets/Main.scene.hasset",
    graphId: "scene:assets/Main.scene.hasset",
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
  it("keeps each document's list while another is active, and ignores publishers from an earlier visit", () => {
    let current!: ReturnType<typeof useValidation>;
    function Probe() { current = useValidation(); return null; }
    const view = render(<ValidationProvider scopeKey="class-a"><Probe /></ValidationProvider>);
    const error = { ...pairingWarning("Invalid graph"), severity: "error" as const };
    const late = { ...error, message: "Reported after the switch" };
    act(() => { current.setDiagnostics([error]); current.setFocusDiagnostic(error); });
    expect(current.errorCount).toBe(1);
    const firstVisit = current;
    view.rerender(<ValidationProvider scopeKey="material-b"><Probe /></ValidationProvider>);
    expect(current.diagnostics).toEqual([]);
    expect(current.focusDiagnostic).toBeNull();
    // A publisher that finishes after the switch, as Play does, still reports into its own document;
    // it cannot move the focus of the one now shown.
    act(() => { firstVisit.setDiagnostics([error, late]); firstVisit.setFocusDiagnostic(error); });
    expect(current.diagnostics).toEqual([]);
    expect(current.focusDiagnostic).toBeNull();
    view.rerender(<ValidationProvider scopeKey="class-a"><Probe /></ValidationProvider>);
    expect(current.diagnostics.map((entry) => entry.message)).toEqual(["Invalid graph", "Reported after the switch"]);
    expect(current.focusDiagnostic).toBeNull();
    act(() => firstVisit.setDiagnostics([]));
    expect(current.errorCount).toBe(2);
    act(() => current.setDiagnostics([error]));
    expect(current.errorCount).toBe(1);
  });

  it("replaces only the rows a live check owns, and the whole list for Play", () => {
    const validation = renderValidation();
    const other = { ...pairingWarning("Another asset"), assetGuid: "assets/Hero.class.hasset", graphId: "graph:assets/Hero.class.hasset" };
    const own = pairingWarning("Old scene check");
    const ownsScene = { replaces: (d: Diagnostic) => d.assetGuid === "assets/Main.scene.hasset" };
    act(() => validation().setDiagnostics([other, own]));
    act(() => validation().setDiagnostics([pairingWarning("New scene check")], ownsScene));
    expect(validation().diagnostics.map((entry) => entry.message)).toEqual(["Another asset", "New scene check"]);
    act(() => validation().setDiagnostics([], ownsScene));
    expect(validation().diagnostics.map((entry) => entry.message)).toEqual(["Another asset"]);
    act(() => validation().setDiagnostics([own]));
    expect(validation().diagnostics.map((entry) => entry.message)).toEqual(["Old scene check"]);
  });

  it("drops a closed document's list, never the active one's", () => {
    let current!: ReturnType<typeof useValidation>;
    function Probe() { current = useValidation(); return null; }
    const view = (scopeKey: string, open: string[]) => (
      <ValidationProvider scopeKey={scopeKey} retainScopeKeys={open}><Probe /></ValidationProvider>
    );
    const { rerender } = render(view("a", ["a", "b"]));
    act(() => current.setDiagnostics([pairingWarning("In a")]));
    rerender(view("b", ["a", "b"]));
    act(() => current.setDiagnostics([pairingWarning("In b")]));
    // a closes; b, still active, keeps its list even when its tab is not listed yet.
    rerender(view("b", []));
    expect(current.diagnostics.map((entry) => entry.message)).toEqual(["In b"]);
    rerender(view("a", ["a"]));
    expect(current.diagnostics).toEqual([]);
  });

  it("carries an explicit navigation target and body line into its destination only", () => {
    let current!: ReturnType<typeof useValidation>;
    function Probe() { current = useValidation(); return null; }
    const view = render(<ValidationProvider scopeKey="scene"><Probe /></ValidationProvider>);
    const target: Diagnostic = { ...pairingWarning("Script failure"), graphId: "class-a", nodeId: "script", bodyLine: 12 };
    const stale = current;
    act(() => {
      current.setDiagnostics([pairingWarning("Scene issue")]);
      current.setFocusDiagnostic(target, "class-a");
    });
    // A matching node ID in the source document must not receive this focus.
    expect(current.focusDiagnostic).toBeNull();
    view.rerender(<ValidationProvider scopeKey="class-a"><Probe /></ValidationProvider>);
    expect(current.diagnostics).toEqual([]);
    expect(current.focusDiagnostic).toEqual(target);
    // Completing the previous document's validation cannot erase the navigation.
    act(() => { stale.setDiagnostics([pairingWarning("Old scene issue")]); stale.setFocusDiagnostic(null); });
    expect(current.diagnostics).toEqual([]);
    expect(current.focusDiagnostic?.bodyLine).toBe(12);
    view.rerender(<ValidationProvider scopeKey="material"><Probe /></ValidationProvider>);
    expect(current.focusDiagnostic).toBeNull();
    view.rerender(<ValidationProvider scopeKey="class-a"><Probe /></ValidationProvider>);
    expect(current.focusDiagnostic).toBeNull();
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
