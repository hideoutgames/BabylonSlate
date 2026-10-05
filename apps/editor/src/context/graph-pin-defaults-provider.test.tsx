import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PinType } from "@babylonslate/scripting";
import type { PinDefaultEditorRequest } from "@babylonslate/graph-ui";
import { GraphPinDefaultEditor, type GraphPinDefaultCatalogs } from "./graph-pin-defaults-provider";
import { classParentLookup } from "../lib/content-browser-helpers";
import { subclassClassEntries } from "../lib/component-property-rows";

afterEach(cleanup);

const assets = [
  { path: "assets/Hero.class.babasset", header: { guid: "hero", type: "Class", name: "Hero", parentClass: "Actor" } },
  { path: "assets/Service.class.babasset", header: { guid: "service", type: "Class", name: "Service", parentClass: "BObject" } },
  { path: "assets/Brick.texture.babasset", header: { guid: "brick", type: "Texture", name: "Brick" } },
  { path: "assets/BrickSound.audio.babasset", header: { guid: "sound", type: "Audio", name: "Brick Sound" } },
  { path: "assets/Tool.class.babasset", header: { guid: "tool", type: "Class", name: "Tool", parentClass: "EditorUtilityObject" } },
];
const catalogs: GraphPinDefaultCatalogs = {
  assets,
  pickerAssets: assets.map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path })),
  assetEntries: assets.map((asset) => ({ id: asset.header.guid, name: asset.header.name, type: asset.header.type })),
  classEntries: subclassClassEntries("BObject", assets),
  parentOf: classParentLookup(assets),
  enumMembers: { mood: ["Ready", "inMotion"] },
  materialDocuments: [],
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
  it("selects an enum member using the schema while preserving its stored spelling", async () => {
    const input = request({ kind: "enumRef", guid: "mood" }, "Ready");
    render(<GraphPinDefaultEditor request={input} catalogs={catalogs} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Value" }));
    fireEvent.click(await screen.findByRole("option", { name: "In Motion" }));
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
