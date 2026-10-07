import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";
import type { RuntimeInspectorResult, RuntimeObjectIdentity } from "@babylonslate/bridge";
import { identitySerializedTransform } from "@babylonslate/core";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { SimulationInspectionStore } from "../services/simulation-inspection-store";
import { SimulationInspector } from "./simulation-inspector";

vi.mock("../context/document-context", () => ({
  useActiveDocumentId: () => "scene",
  useRegistryState: () => ({ registryEpoch: 0, assetRegistry: null }),
}));
vi.mock("../context/scene-editing-context", () => ({ useOptionalSceneEditing: () => ({ viewportMode: "3d" }) }));
const target: RuntimeObjectIdentity = { sceneInstanceId: "root", actorGuid: "actor", actorToken: 1 };
const reply = (payload: RuntimeInspectorResult["payload"], commandRevision = 0): RuntimeInspectorResult => ({
  sessionGeneration: 1, requestId: 1, success: true, tickIndex: 1, frameId: 1, structuralRevision: 1, commandRevision, payload,
});
afterEach(() => vi.useRealTimers());

it("keeps a focused text draft while runtime polls update and commits through the runtime transport", async () => {
  vi.useFakeTimers();
  let name = "Initial";
  const writes: unknown[] = [];
  const store = new SimulationInspectionStore();
  store.attach(async action => {
    if (action.kind === "identities") return reply({ kind: "identities", unchanged: true, rows: [] });
    if (action.kind === "setProperty") {
      writes.push(action); name = String(action.value);
      return reply({ kind: "mutation", target, sequence: 1, effectiveValue: name }, 1);
    }
    return reply({ kind: "selection", target, classId: "Actor", transform: identitySerializedTransform(), transformCapability: "live",
      properties: [{ key: "name", name: "Name", typeId: "string", capability: "live", value: name }] });
  });
  store.select(target);
  const view = render(<DocumentWorkspaceProvider documentId="scene"><SimulationInspector store={store} panel={{} as IDockviewPanelProps} /></DocumentWorkspaceProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const input = screen.getByDisplayValue("Initial");
  act(() => { input.focus(); });
  fireEvent.change(input, { target: { value: "My Draft" } });
  name = "Changed by Gameplay";
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(screen.getByDisplayValue("My Draft")).toBe(input);
  expect(writes).toHaveLength(0);
  await act(async () => { input.blur(); });
  expect(writes).toEqual([{ kind: "setProperty", target, property: "name", value: "My Draft" }]);
  expect(screen.getByDisplayValue("My Draft")).toBe(input);
  view.unmount();
  const before = store.getSnapshot();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(store.getSnapshot()).toBe(before);
});
