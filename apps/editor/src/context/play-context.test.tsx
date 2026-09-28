import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { engineCommandBus } from "@babylonslate/core";
import {
  PlayProvider,
  useLiveBtState,
  useOptionalPlay,
  useOutputLog,
  usePlay,
  type LiveBtState,
} from "./play-context";

const host = vi.hoisted(() => {
  const diagnostics = new Set<(line: string) => void>();
  return {
    diagnostics,
    documents: {
      openDocuments: [],
      activeDocumentId: null,
      projectDocument: null,
      dirtyDocuments: [],
      migrationPending: [],
      onSessionDiagnostic: (listener: (line: string) => void) => {
        diagnostics.add(listener);
        return () => {
          diagnostics.delete(listener);
        };
      },
    },
    validation: { setDiagnostics: vi.fn(), setFocusDiagnostic: vi.fn() },
    settings: {
      settings: { debuggerDefaults: { overlayStats: false } },
      updateDebuggerDefaults: vi.fn(async () => {}),
    },
  };
});

// Session data and settings are external to the subscription boundary under test.
vi.mock("./document-context", () => ({ useDocuments: () => host.documents }));
vi.mock("./validation-context", () => ({
  useValidation: () => host.validation,
}));
vi.mock("./app-settings-context", () => ({
  useAppSettings: () => host.settings,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("delivers logs and BT snapshots only to their subscribers while Play controls stay live", () => {
  const renders = { play: 0, optional: 0, log: 0, bt: 0 };
  let controls!: ReturnType<typeof usePlay>;
  function PlayConsumer() {
    controls = usePlay();
    renders.play += 1;
    return (
      <output data-testid="play-controls">
        {String(controls.overlayStats)}
      </output>
    );
  }
  function OptionalConsumer() {
    const play = useOptionalPlay();
    renders.optional += 1;
    return (
      <output data-testid="optional-controls">
        {String(play?.overlayStats)}
      </output>
    );
  }
  function LogConsumer() {
    const { lines } = useOutputLog();
    renders.log += 1;
    return <output data-testid="logs">{lines.join("\n")}</output>;
  }
  function BtConsumer() {
    const state = useLiveBtState();
    renders.bt += 1;
    return (
      <output data-testid="bt-state">
        {state ? `${state.btNodeId}:${state.blackboard.hp}` : "None"}
      </output>
    );
  }
  const view = render(
    <PlayProvider>
      <PlayConsumer />
      <OptionalConsumer />
      <LogConsumer />
      <BtConsumer />
    </PlayProvider>,
  );
  expect(screen.getByTestId("play-controls").textContent).toBe("false");
  const initial = { ...renders };
  const writer = controls.reportBtState;
  act(() =>
    engineCommandBus.dispatch({
      type: "log",
      message: "Engine Line",
    }),
  );
  act(() => {
    for (const listener of host.diagnostics) listener("Session Line");
  });
  act(() => controls.appendLog("Utility Line"));
  expect(screen.getByTestId("logs").textContent).toBe(
    "[Engine] Engine Line\nSession Line\nUtility Line",
  );
  expect(renders.log).toBeGreaterThan(initial.log);
  expect(renders.play).toBe(initial.play);
  expect(renders.optional).toBe(initial.optional);
  expect(renders.bt).toBe(initial.bt);

  const afterLogs = { ...renders };
  const snapshot: LiveBtState = {
    slotId: 1,
    status: "running",
    btNodeId: "wait",
    lastResults: {},
    blackboard: { hp: 3 },
    stack: [{ nodeId: "sequence", childIndex: 0, opened: true }],
  };
  act(() => writer(snapshot));
  expect(screen.getByTestId("bt-state").textContent).toBe("wait:3");
  act(() => writer({ ...snapshot, btNodeId: "attack", blackboard: { hp: 2 } }));
  expect(screen.getByTestId("bt-state").textContent).toBe("attack:2");
  expect(renders.bt).toBeGreaterThan(afterLogs.bt);
  expect(renders.log).toBe(afterLogs.log);
  expect(renders.play).toBe(initial.play);
  expect(renders.optional).toBe(initial.optional);
  expect(controls.reportBtState).toBe(writer);

  act(() => writer(null));
  expect(screen.getByTestId("bt-state").textContent).toBe("None");
  expect(renders.log).toBe(afterLogs.log);
  expect(renders.play).toBe(initial.play);
  const beforeControlChange = { ...renders };
  act(() => controls.setOverlayStats(true));
  expect(screen.getByTestId("play-controls").textContent).toBe("true");
  expect(screen.getByTestId("optional-controls").textContent).toBe("true");
  expect(renders.play).toBeGreaterThan(beforeControlChange.play);
  expect(renders.log).toBe(beforeControlChange.log);
  expect(renders.bt).toBe(beforeControlChange.bt);
  expect(controls.reportBtState).toBe(writer);
  view.unmount();
  expect(host.diagnostics.size).toBe(0);
});
