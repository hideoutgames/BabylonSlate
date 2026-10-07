import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { IndexedAsset } from "@babylonslate/assets";
import type { OpenDocument } from "../services/document-service";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { DataDefinitionEditingProvider } from "../context/data-definition-editing-context";
import { DataDefinitionFieldsPanel, DataDefinitionDetailsPanel } from "./data-definition-panel";

const state = vi.hoisted(() => ({ documents: [] as OpenDocument[], assets: [] as IndexedAsset[], apply: vi.fn(), readOnly: false }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: state.documents, getOpenDocuments: () => state.documents,
  applyAssetDocumentChange: state.apply,
  assetRegistry: { list: () => state.assets, getRoot: () => ({ readOnly: state.readOnly }) },
})));
const path = "assets/Weapon.datadefinition.babasset";
const id = `data-definition:${path}`;
const props = {} as IDockviewPanelProps;
function View({ showFields = true }: { showFields?: boolean }) {
  return <DocumentWorkspaceProvider documentId={id}><DataDefinitionEditingProvider>
    {showFields ? <DataDefinitionFieldsPanel {...props} /> : null}
    <DataDefinitionDetailsPanel {...props} />
  </DataDefinitionEditingProvider></DocumentWorkspaceProvider>;
}
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

it("retains field identity while editing names, typed defaults and field rules across docks", async () => {
  const view = render(<View />);
  const fields = within(screen.getByTestId("data-definition-fields-panel"));
  const details = within(screen.getByTestId("data-definition-details-panel"));
  expect(fields.queryByRole("textbox", { name: "Default Value" })).toBeNull();
  expect(details.getByRole("textbox", { name: "Default Value" })).toBeTruthy();
  fireEvent.doubleClick(screen.getByTestId("definition-field-damage-name"));
  const rename = screen.getByRole("textbox", { name: "Field 1 name" });
  fireEvent.change(rename, { target: { value: "Power" } });
  fireEvent.keyDown(rename, { key: "Enter" });
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
  fireEvent.click(screen.getByTestId("definition-field-add"));
  fireEvent.click(await screen.findByTestId("search-item-float"));
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ name: "Damage" }, { name: "NewField", typeId: "float", defaultValue: 0 }] }));
  view.rerender(<View />);
  expect((within(screen.getByTestId("data-definition-details-panel")).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("NewField");
  // Closing Fields must not lose the document's selected field.
  view.rerender(<View showFields={false} />);
  fireEvent.click(screen.getByTestId("inspector-member-container-array"));
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ name: "Damage" }, { name: "NewField", container: "array", defaultValue: [] }] }));
});

it("keeps locked definition fields and rules read-only", () => {
  state.readOnly = true;
  render(<View />);
  expect(screen.queryByTestId("definition-field-add")).toBeNull();
  fireEvent.doubleClick(screen.getByTestId("definition-field-damage-name"));
  expect(screen.queryByRole("textbox", { name: "Field 1 name" })).toBeNull();
  expect((screen.getByRole("textbox", { name: "Default Value" }) as HTMLInputElement).disabled).toBe(true);
  expect(state.apply).not.toHaveBeenCalled();
});

it("saves nested default identities and projects later renames without losing retired asset values", async () => {
  const child = { kind: "dataDefinition", fields: [
    { id: "count", name: "Count", typeId: "int" },
    { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
  ] };
  const root = { kind: "dataDefinition", fields: [{ id: "child", name: "Child", typeId: "struct", typeClassId: "child", defaultValue: { Count: 2, Icon: "texture-guid" } }] };
  state.documents[0]!.content = root;
  state.assets[0]!.header.payload = root;
  state.assets.push({ ...state.assets[0]!, path: "assets/Child.datadefinition.babasset", header: { ...state.assets[0]!.header, guid: "child", name: "Child", payload: child } });
  const view = render(<View />);
  fireEvent.change(screen.getByRole("textbox", { name: "Default Value Count" }), { target: { value: "7" } });
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{
    defaultValue: { Count: 7, Icon: "texture-guid" }, fields: [
      { id: "count", name: "Count", typeId: "int" },
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
    ],
  }] }));
  state.assets = state.assets.map(asset => asset.header.guid === "child" ? {
    ...asset, header: { ...asset.header, payload: { kind: "dataDefinition", fields: [{ id: "count", name: "Total", typeId: "int" }] } },
  } : asset);
  view.rerender(<View />);
  expect((screen.getByRole("textbox", { name: "Default Value Total" }) as HTMLInputElement).value).toBe("7");
  fireEvent.change(screen.getByRole("textbox", { name: "Default Value Total" }), { target: { value: "9" } });
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{
    defaultValue: { Total: 9, Icon: "texture-guid" }, fields: [
      { id: "count", name: "Total", typeId: "int" },
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
    ],
  }] }));
  expect((state.documents[0]!.content.fields as { defaultValue: Record<string, unknown> }[])[0]!.defaultValue).not.toHaveProperty("Count");
});

it("keeps recursive definitions editable without expanding their recursive defaults", () => {
  const root = { kind: "dataDefinition", fields: [{ id: "child", name: "Child", typeId: "struct", typeClassId: "child" }] };
  const child = { kind: "dataDefinition", fields: [{ id: "parent", name: "Parent", typeId: "struct", typeClassId: "weapon" }] };
  state.documents[0]!.content = root;
  state.assets[0]!.header.payload = root;
  state.assets.push({ ...state.assets[0]!, path: "assets/Child.datadefinition.babasset", header: { ...state.assets[0]!.header, guid: "child", name: "Child", payload: child } });
  render(<View />);
  expect(screen.getByRole("alert").textContent).toMatch(/cannot reference themselves/i);
  expect(screen.getByTestId("definition-field-child-name").textContent).toBe("Child");
  expect(screen.queryByRole("textbox", { name: /^Default Value/ })).toBeNull();
});

it("changes the selected field from Fields and falls back after removing that field", async () => {
  state.documents[0]!.content = { kind: "dataDefinition", fields: [
    { id: "damage", name: "Damage", typeId: "float", defaultValue: 12 },
    { id: "health", name: "Health", typeId: "int", defaultValue: 100 },
  ] };
  const view = render(<View />);
  fireEvent.click(screen.getByTestId("definition-field-health-name"));
  expect((screen.getByRole("textbox", { name: "Default Value" }) as HTMLInputElement).value).toBe("100");
  fireEvent.change(screen.getByRole("textbox", { name: "Default Value" }), { target: { value: "200" } });
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [
    { id: "damage", defaultValue: 12 }, { id: "health", defaultValue: 200 },
  ] }));
  view.rerender(<View />);
  fireEvent.click(screen.getByRole("button", { name: "Remove Health" }));
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ id: "damage", name: "Damage", defaultValue: 12 }] }));
  view.rerender(<View />);
  expect((screen.getByRole("textbox", { name: "Default Value" }) as HTMLInputElement).value).toBe("12");
});

it("switches a Tag Container to a nested Definition in Details and initializes its default", async () => {
  const root = { kind: "dataDefinition", fields: [{ id: "child", name: "Child", typeId: "struct", typeClassId: "engine:TagContainer" }] };
  state.documents[0]!.content = root;
  state.assets[0]!.header.payload = root;
  state.assets.push({ ...state.assets[0]!, path: "assets/Stats.datadefinition.babasset", header: { ...state.assets[0]!.header, guid: "stats", name: "Stats", payload: { kind: "dataDefinition", fields: [{ id: "count", name: "Count", typeId: "int", defaultValue: 5 }] } } });
  const view = render(<View />);
  const details = within(screen.getByTestId("data-definition-details-panel"));
  expect(details.queryByRole("button", { name: "Data Definition Type" })).toBeNull();
  fireEvent.click(details.getByTestId("inspector-member-type"));
  fireEvent.click(await screen.findByTestId("search-item-struct"));
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ id: "child", typeId: "struct", typeClassId: undefined }] }));
  view.rerender(<View />);
  fireEvent.click(details.getByRole("button", { name: "Data Definition Type" }));
  fireEvent.click(await screen.findByTestId("search-item-stats"));
  await waitFor(() => expect(state.documents[0]!.content).toMatchObject({ fields: [{ id: "child", typeClassId: "stats", defaultValue: { Count: 5 } }] }));
  view.rerender(<View />);
  expect((details.getByRole("textbox", { name: "Default Value Count" }) as HTMLInputElement).value).toBe("5");
});
