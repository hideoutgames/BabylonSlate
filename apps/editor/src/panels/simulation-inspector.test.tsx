import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";
import type { RuntimeInspectorResult, RuntimeObjectIdentity } from "@haptic/bridge";
import { identitySerializedTransform } from "@haptic/core";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { SimulationInspectionStore } from "../services/simulation-inspection-store";
import { SimulationInspector } from "./simulation-inspector";

const documents = vi.hoisted(() => ({ value: { activeDocumentId: "scene", assetRegistry: null as unknown } }));
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => documents.value as never));
vi.mock("../context/scene-editing-context", () => ({ useOptionalSceneEditing: () => ({ viewportMode: "3d" }) }));
const target: RuntimeObjectIdentity = { sceneInstanceId: "root", actorGuid: "actor", actorToken: 1 };
const reply = (payload: RuntimeInspectorResult["payload"], commandRevision = 0): RuntimeInspectorResult => ({
  sessionGeneration: 1, requestId: 1, success: true, tickIndex: 1, frameId: 1, identityRevision: 1, commandRevision, payload,
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

it("edits particle parameters as a number, a vector and a color through the runtime transport", async () => {
  vi.useFakeTimers();
  const writes: unknown[] = [];
  const component: RuntimeObjectIdentity = { ...target, componentGuid: "sparks", componentToken: 2 };
  const store = new SimulationInspectionStore();
  store.attach(async action => {
    if (action.kind === "identities") return reply({ kind: "identities", unchanged: true, rows: [] });
    if (action.kind === "setProperty") {
      writes.push(action);
      return reply({ kind: "mutation", target: component, sequence: 1, effectiveValue: action.value }, 1);
    }
    return reply({ kind: "selection", target: component, classId: "ParticleComponent", transform: identitySerializedTransform(), transformCapability: "live",
      properties: [
        { key: "particle:Heat", name: "Heat", typeId: "particle:float", capability: "live", value: 2 },
        { key: "particle:Wind", name: "Wind", typeId: "particle:vec2", capability: "live", value: { x: 1, y: 2 } },
        { key: "particle:Tint", name: "Tint", typeId: "particle:color", capability: "live", value: { x: 1, y: 1, z: 1, w: 1 } },
      ] });
  });
  store.select(component);
  const view = render(<DocumentWorkspaceProvider documentId="scene"><SimulationInspector store={store} panel={{} as IDockviewPanelProps} /></DocumentWorkspaceProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const heat = screen.getByTestId("property-simulation-particle:Heat") as HTMLInputElement;
  expect(heat.value).toBe("2");
  fireEvent.change(heat, { target: { value: "5" } });
  await act(async () => { heat.blur(); await vi.advanceTimersByTimeAsync(0); });
  expect(writes).toContainEqual({ kind: "setProperty", target: component, property: "particle:Heat", value: 5 });
  // Wind shows X and Y only; Tint is a color row.
  expect(screen.getByTestId("property-simulation-particle:Wind-y")).toBeTruthy();
  expect(screen.queryByTestId("property-simulation-particle:Wind-z")).toBeNull();
  expect(screen.getByTestId("property-simulation-particle:Tint")).toBeTruthy();
  view.unmount();
});

// As every Inspector Material field: a running component's Material lists, pastes and accepts only its domain's
// Materials, an Instance by its root's domain and a Material with no recorded domain on Surface fields alone.
it.each([
  { classId: "MeshComponent", held: "ui-mat", listed: ["surface-mat", "legacy-mat", "surface-inst"],
    error: "Needs a Surface Material; this is a User Interface Material." },
  { classId: "2DMaterialComponent", held: "surface-mat", listed: ["ui-mat", "ui-inst"],
    error: "Needs a User Interface Material; this is a Surface Material." },
])("lists and accepts only the Materials a $classId draws", async ({ classId, held, listed, error }) => {
  const material = (guid: string, type: string, payload: Record<string, unknown>) =>
    ({ path: `assets/${guid}.hasset`, header: { guid, name: guid, type, parentClass: null, payload } });
  const assets = [
    material("surface-mat", "Material", { domain: "surface" }),
    material("ui-mat", "Material", { domain: "ui" }),
    // Saved before the editor recorded domains: it loads as Surface.
    material("legacy-mat", "Material", {}),
    material("surface-inst", "MaterialInstance", { parentGuid: "surface-mat" }),
    // Its cached domain is stale: its root decides.
    material("ui-inst", "MaterialInstance", { parentGuid: "ui-mat", domain: "surface" }),
  ];
  documents.value = { activeDocumentId: "scene", assetRegistry: { list: () => assets } };
  const writes: unknown[] = [];
  const component: RuntimeObjectIdentity = { ...target, componentGuid: "visual", componentToken: 2 };
  const store = new SimulationInspectionStore();
  store.attach(async action => {
    if (action.kind === "identities") return reply({ kind: "identities", unchanged: true, rows: [] });
    if (action.kind === "setProperty") {
      writes.push(action);
      return reply({ kind: "mutation", target: component, sequence: 1, effectiveValue: action.value }, 1);
    }
    return reply({ kind: "selection", target: component, classId, transform: identitySerializedTransform(), transformCapability: "live",
      materialGuid: held, properties: [{ key: "materialGuid", name: "Material", typeId: "asset", capability: "live", value: held }] });
  });
  store.select(component);
  const view = render(<DocumentWorkspaceProvider documentId="scene"><SimulationInspector store={store} panel={{} as IDockviewPanelProps} /></DocumentWorkspaceProvider>);
  try {
    fireEvent.click(await screen.findByTestId("property-simulation-materialGuid"));
    expect(screen.getByText(error)).toBeTruthy();
    await screen.findByTestId(`search-item-${listed[0]}`);
    for (const asset of assets) {
      const shown = screen.queryByTestId(`search-item-${asset.header.guid}`) !== null;
      expect([asset.header.guid, shown]).toEqual([asset.header.guid, listed.includes(asset.header.guid)]);
    }
    fireEvent.click(screen.getByTestId(`search-item-${listed[0]}`));
    await waitFor(() => expect(writes).toEqual([{ kind: "setProperty", target: component, property: "materialGuid", value: listed[0] }]));
  } finally {
    view.unmount();
    documents.value = { activeDocumentId: "scene", assetRegistry: null };
  }
});
