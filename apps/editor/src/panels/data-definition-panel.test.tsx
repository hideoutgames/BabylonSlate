import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { IndexedAsset } from "@babylonslate/assets";
import type { OpenDocument } from "../services/document-service";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { DataDefinitionFieldsPanel } from "./data-definition-panel";

const state = vi.hoisted(() => ({ documents: [] as OpenDocument[], assets: [] as IndexedAsset[], apply: vi.fn(), readOnly: false }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: state.documents, getOpenDocuments: () => state.documents,
  applyAssetDocumentChange: state.apply,
  assetRegistry: { list: () => state.assets, getRoot: () => ({ readOnly: state.readOnly }) },
})));
const path = "assets/Weapon.datadefinition.babasset";
const id = `data-definition:${path}`;
const props = {} as IDockviewPanelProps;
function View() { return <DocumentWorkspaceProvider documentId={id}><DataDefinitionFieldsPanel {...props} /></DocumentWorkspaceProvider>; }
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  state.readOnly = false;
  const payload = { kind: "dataDefinition", fields: [{ id: "damage", name: "Damage", typeId: "float", defaultValue: 12 }] };
  state.documents = [{ id, ref: { kind: "data-definition", path, label: "Weapon" }, content: payload, layout: null, dirty: false }];
  state.assets = [{ rootId: "project", path, header: { guid: "weapon", name: "Weapon", type: "DataDefinition", version: 1, engineVersion: "0.0.0", mode: "thin", dependencies: [], payload, chunks: [] } }];
  state.apply.mockImplementation(async (_id: string, content: Record<string, unknown>) => {
    state.documents = [{ ...state.documents[0]!, content, dirty: true }];
    return true;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("retains field identity while editing names, typed defaults and field rules", async () => {
  const view = render(<View />);
  fireEvent.change(screen.getByRole("textbox", { name: "Field 1 name" }), { target: { value: "Power" } });
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ id: "damage", name: "Power", defaultValue: 12 }] }));
  view.rerender(<View />);
  fireEvent.change(screen.getByRole("textbox", { name: "Default Value" }), { target: { value: "25" } });
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ id: "damage", defaultValue: 25 }] }));
  view.rerender(<View />);
  fireEvent.change(screen.getByRole("textbox", { name: "Category" }), { target: { value: "Combat" } });
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ category: "Combat", defaultValue: 25 }] }));
  view.rerender(<View />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Limit Minimum" }));
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ min: 0 }] }));
  view.rerender(<View />);
  fireEvent.change(screen.getByRole("textbox", { name: "Minimum" }), { target: { value: "3" } });
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ id: "damage", name: "Power", category: "Combat", min: 3, defaultValue: 25 }] }));
});

it("adds fields without a Structure asset and initializes changed collection defaults", async () => {
  const view = render(<View />);
  fireEvent.change(screen.getByLabelText("Add Field"), { target: { value: "Prices" } });
  fireEvent.click(screen.getByTestId("definition-field-add"));
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ name: "Damage" }, { name: "Prices", typeId: "float", defaultValue: 0 }] }));
  view.rerender(<View />);
  fireEvent.click(screen.getByTestId("inspector-member-container-array"));
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ name: "Damage" }, { name: "Prices", container: "array", defaultValue: [] }] }));
});

it("keeps locked definition fields and rules read-only", () => {
  state.readOnly = true;
  render(<View />);
  expect(screen.queryByTestId("definition-field-add")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Field 1 name" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("textbox", { name: "Default Value" }) as HTMLInputElement).disabled).toBe(true);
  expect(state.apply).not.toHaveBeenCalled();
});

it("keeps recursive definitions editable without expanding their recursive defaults", () => {
  const root = { kind: "dataDefinition", fields: [{ id: "child", name: "Child", typeId: "struct", typeClassId: "child" }] };
  const child = { kind: "dataDefinition", fields: [{ id: "parent", name: "Parent", typeId: "struct", typeClassId: "weapon" }] };
  state.documents[0]!.content = root;
  state.assets[0]!.header.payload = root;
  state.assets.push({ ...state.assets[0]!, path: "assets/Child.datadefinition.babasset", header: { ...state.assets[0]!.header, guid: "child", name: "Child", payload: child } });
  render(<View />);
  expect(screen.getByRole("alert").textContent).toMatch(/cannot reference themselves/i);
  expect(screen.getByRole("textbox", { name: "Field 1 name" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /^Default Value/ })).toBeNull();
});
