import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AssetCreateProvider } from "@babylonslate/editor-kit";
import type { PinType } from "@babylonslate/scripting";
import { GraphEditor, type PinDefaultEditorRequest } from "@babylonslate/graph-ui";
import type { SerializedGraph } from "@babylonslate/core";
import { GraphPinDefaultEditor, GraphPinDefaultsProvider, type GraphPinDefaultCatalogs } from "./graph-pin-defaults-provider";
import { classParentLookup } from "../lib/content-browser-helpers";
import { subclassClassEntries } from "../lib/component-property-rows";

afterEach(cleanup);

const assets = [
  { path: "assets/Hero.class.babasset", header: { guid: "hero", type: "Class", name: "Hero", parentClass: "Actor" } },
  { path: "assets/Service.class.babasset", header: { guid: "service", type: "Class", name: "Service", parentClass: "BObject" } },
  { path: "assets/Brick.texture.babasset", header: { guid: "brick", type: "Texture", name: "Brick" } },
  { path: "assets/BrickSound.audio.babasset", header: { guid: "sound", type: "Audio", name: "Brick Sound" } },
  { path: "assets/Tool.class.babasset", header: { guid: "tool", type: "Class", name: "Tool", parentClass: "EditorUtilityObject" } },
  { path: "assets/Items.babasset", header: { guid: "items", type: "DataTree", name: "Items", payload: {
    defaultDefinitionGuid: "weapon", entries: [{ id: "stable-sword", parentId: null, name: "Sword", values: {} }],
  } } },
];
const documents = {
  assetRegistry: { list: () => assets },
  openDocuments: [] as { ref: { kind: "data-tree"; path: string }; content: unknown }[],
};
vi.mock("./document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => documents),
);
beforeEach(() => { documents.openDocuments = []; });
const catalogs: GraphPinDefaultCatalogs = {
  assets,
  pickerAssets: assets.map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path })),
  assetEntries: assets.map((asset) => ({ id: asset.header.guid, name: asset.header.name, type: asset.header.type })),
  classEntries: subclassClassEntries("BObject", assets),
  parentOf: classParentLookup(assets),
  enumMembers: { mood: ["Ready", "inMotion"] },
  materialDocuments: [],
  dataTrees: [],
};

function request(type: PinType, value: unknown, extra: Partial<PinDefaultEditorRequest> = {}): PinDefaultEditorRequest {
  return {
    nodeId: "node", nodeType: "test.literal", nodeData: {},
    pin: { id: "value", name: "Value", direction: "in", kind: "data", type },
    value, preview: { kind: "string", text: "Display Text Is Not The Stored Value" },
    disabled: false, onChange: vi.fn(), ...extra,
  };
}

describe("project-backed inline pin defaults", () => {
  it("switches entry-path defaults between live tree paths and free text without following entry IDs", async () => {
    const onChange = vi.fn();
    const graph: SerializedGraph = {
      nodes: [
        { id: "source", type: "variables.get", position: { x: 0, y: 200 }, data: {
          __pins: [{ id: "value", name: "Value", direction: "out", kind: "data", type: { kind: "assetRef", assetType: "DataTree" } }],
        } },
        { id: "read", type: "data.readEntry", position: { x: 0, y: 0 }, data: {
          __nodeType: "data.readEntry", "default:tree": "items", "default:entryPath": "Sword",
          __pins: [
            { id: "tree", name: "Tree", direction: "in", kind: "data", type: { kind: "assetRef", assetType: "DataTree" } },
            { id: "entryPath", name: "Entry Path", direction: "in", kind: "data", type: { kind: "string" } },
          ],
        } },
      ], edges: [],
    };
    const show = (value: SerializedGraph) => <GraphPinDefaultsProvider><GraphEditor initialGraph={value} onChange={onChange} /></GraphPinDefaultsProvider>;
    const view = render(show(graph));
    const picker = () => screen.getByTestId("property-read:entryPath");
    expect(picker().getAttribute("role")).toBe("combobox");
    expect(picker().textContent).toContain("Sword");

    documents.openDocuments = [{ ref: { kind: "data-tree", path: "assets/Items.babasset" }, content: {
      defaultDefinitionGuid: "weapon", entries: [{ id: "stable-sword", parentId: null, name: "Longsword", values: {} }],
    } }];
    view.rerender(show(graph));
    expect(picker().textContent).toContain("Missing Entry (Sword)");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(picker());
    const option = await screen.findByTestId("search-item-Longsword");
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const edited = onChange.mock.lastCall![0] as SerializedGraph;
    expect(edited.nodes.find((node) => node.id === "read")?.data["default:entryPath"]).toBe("Longsword");
    expect(edited.nodes.find((node) => node.id === "read")?.data["default:entryId"]).toBeUndefined();

    const cleared = { ...edited, nodes: edited.nodes.map((node) => node.id === "read"
      ? { ...node, data: { ...node.data, "default:tree": "" } } : node) };
    view.rerender(show(cleared));
    const textbox = await screen.findByTestId("pin-default-read-entryPath");
    expect(textbox.tagName).toBe("INPUT");
    expect((textbox as HTMLInputElement).value).toBe("Longsword");
    fireEvent.change(textbox, { target: { value: "Dynamic Name" } });
    fireEvent.blur(textbox);
    await waitFor(() => expect((onChange.mock.lastCall![0] as SerializedGraph).nodes.find((node) => node.id === "read")?.data["default:entryPath"]).toBe("Dynamic Name"));

    view.rerender(show({ ...edited, edges: [{ id: "sheet-input", source: "source", sourceHandle: "value", target: "read", targetHandle: "tree" }] }));
    await waitFor(() => {
      expect(screen.queryByTestId("property-read:entryPath")).toBeNull();
      expect((screen.getByTestId("pin-default-read-entryPath") as HTMLInputElement).value).toBe("Longsword");
    });
    view.rerender(show(edited));
    await waitFor(() => expect(picker().textContent).toContain("Longsword"));
  });

  it("selects an enum member using the schema while preserving its stored spelling", async () => {
    const input = request({ kind: "enumRef", guid: "mood" }, "Ready");
    render(<GraphPinDefaultEditor request={input} catalogs={catalogs} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Value" }));
    const option = await screen.findByRole("option", { name: "In Motion" });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    expect(input.onChange).toHaveBeenCalledWith("inMotion");
  });

  it("limits class choices to the pin's ancestry constraint and writes the selected class ID", () => {
    const input = request({ kind: "classRef", classId: "Actor" }, "Actor");
    render(<GraphPinDefaultEditor request={input} catalogs={catalogs} />);
    fireEvent.click(screen.getByRole("button", { name: "Value" }));
    expect(screen.queryByTestId("search-item-Service")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-Hero"));
    expect(input.onChange).toHaveBeenCalledWith("Hero");
  });

  it("filters asset choices by pin type and stores the guid rather than its display name", () => {
    const input = request({ kind: "assetRef", assetType: "Texture" }, "");
    render(<GraphPinDefaultEditor request={input} catalogs={catalogs} />);
    fireEvent.click(screen.getByRole("button", { name: "Value" }));
    expect(screen.queryByTestId("search-item-sound")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-brick"));
    expect(input.onChange).toHaveBeenCalledWith("brick");
  });

  it.each([
    ["data.readEntry", "tree", "DataTree"],
    ["editorData.updateEntry", "tree", "DataTree"],
  ])("creates a typed %s reference from its inline %s picker", async (nodeType, pinId, assetType) => {
    const createAsset = vi.fn(async () => "created-data");
    const input = request({ kind: "assetRef", assetType }, "", {
      nodeType, nodeData: { definitionGuid: "weapon" },
      pin: { id: pinId, name: "Value", direction: "in", kind: "data", type: { kind: "assetRef", assetType } },
    });
    render(<AssetCreateProvider value={{ canCreate: (type) => type === assetType, typeLabel: (type) => type, createAsset }}>
      <GraphPinDefaultEditor request={input} catalogs={catalogs} />
    </AssetCreateProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Value" }));
    fireEvent.change(screen.getByTestId("graph-pin-asset-picker-query"), { target: { value: "New Weapon" } });
    fireEvent.click(screen.getByTestId(`search-item-__create__${assetType}`));
    await waitFor(() => expect(input.onChange).toHaveBeenCalledWith("created-data"));
    expect(createAsset).toHaveBeenCalledWith({ type: assetType, name: "New Weapon", defaultDefinitionGuid: "weapon" });
  });

  it("uses the owning editor graph's class access for a general Class pin", () => {
    const input = request({ kind: "classRef", classId: "BObject" }, "BObject");
    render(<GraphPinDefaultEditor request={input} catalogs={catalogs} editorGraph />);
    fireEvent.click(screen.getByRole("button", { name: "Value" }));
    fireEvent.click(screen.getByTestId("search-item-Tool"));
    expect(input.onChange).toHaveBeenCalledWith("Tool");
  });

  it("closes an asset picker when its pin constraint changes and uses the new constraint when reopened", () => {
    const input = request({ kind: "assetRef", assetType: "Texture" }, "");
    const view = render(<GraphPinDefaultEditor request={input} catalogs={catalogs} />);
    fireEvent.click(screen.getByRole("button", { name: "Value" }));
    expect(screen.getByTestId("search-item-brick")).toBeTruthy();
    const next = { ...input, pin: { ...input.pin, type: { kind: "assetRef", assetType: "Audio" } } };
    view.rerender(<GraphPinDefaultEditor request={next} catalogs={catalogs} />);
    fireEvent.click(screen.getByRole("button", { name: "Value" }));
    expect(screen.queryByTestId("search-item-brick")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-sound"));
    expect(input.onChange).toHaveBeenCalledOnce();
    expect(input.onChange).toHaveBeenCalledWith("sound");
  });

  it("disables reference controls while retaining the selected asset's display name", () => {
    const input = request({ kind: "assetRef", assetType: "Texture" }, "brick", { disabled: true });
    const view = render(<GraphPinDefaultEditor request={input} catalogs={catalogs} />);
    const control = screen.getByRole("button", { name: "Value" });
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(within(view.container).getByText("Brick")).toBeTruthy();
    fireEvent.click(control);
    expect(screen.queryByTestId("search-item-brick")).toBeNull();
    expect(input.onChange).not.toHaveBeenCalled();
  });

});
