import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
import { AssetOpenProvider } from "@babylonslate/editor-kit";
import { InspectorPanel } from "./inspector-panel";
import { MyClassPanel } from "./my-class-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applyGraphChange = vi.hoisted(() =>
  vi.fn<(id: string, next: SerializedGraph) => Promise<boolean>>(
    async () => true,
  ),
);

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "graph:assets/Hero.class.babasset",
        ref: {
          kind: "graph",
          path: "assets/Hero.class.babasset",
          label: "Hero Class",
        },
        content: {
          nodes: [],
          edges: [],
          members: [
            { id: "var-1", kind: "variable", name: "Health", typeId: "bool" },
            {
              id: "var-obj",
              kind: "variable",
              name: "Target",
              typeId: "object",
              typeClassId: "Hero",
            },
            {
              id: "var-class",
              kind: "variable",
              name: "Kind",
              typeId: "class",
              typeClassId: "Actor",
              defaultValue: "Hero",
            },
            {
              id: "var-struct",
              kind: "variable",
              name: "Stats",
              typeId: "struct",
              typeClassId: "struct-stats",
            },
            {
              id: "var-enum",
              kind: "variable",
              name: "Team",
              typeId: "enum",
              typeClassId: "enum-colors",
            },
            {
              id: "var-actor",
              kind: "variable",
              name: "Pawn",
              typeId: "actor",
              typeClassId: "Actor",
            },
            {
              id: "var-asset",
              kind: "variable",
              name: "Cue",
              typeId: "asset",
              typeClassId: "Audio",
              defaultValue: "audio-1",
            },
            {
              id: "var-array",
              kind: "variable",
              name: "Hits",
              typeId: "rotator",
              container: "array",
            },
            {
              id: "var-array-filled",
              kind: "variable",
              name: "Filled Hits",
              typeId: "rotator",
              container: "array",
              defaultValue: [{ pitch: 1, yaw: 0, roll: 0 }],
            },
            {
              id: "var-array-bool",
              kind: "variable",
              name: "Flags",
              typeId: "bool",
              container: "array",
              defaultValue: [true],
            },
            {
              id: "var-array-float",
              kind: "variable",
              name: "Amounts",
              typeId: "float",
              container: "array",
              defaultValue: [1.5],
            },
            {
              id: "var-map",
              kind: "variable",
              name: "By Name",
              typeId: "float",
              container: "map",
              keyTypeId: "string",
            },
            {
              id: "var-map-filled",
              kind: "variable",
              name: "Scores",
              typeId: "float",
              container: "map",
              keyTypeId: "string",
              defaultValue: [{ key: "a", value: 1 }],
            },
            { id: "fn-1", kind: "function", name: "Jump", pins: [] },
            {
              id: "loc-1",
              kind: "variable",
              name: "Temp",
              typeId: "float",
              functionId: "fn-1",
            },
            {
              id: "fn-impl",
              kind: "function",
              name: "Apply Damage",
              pins: [],
              implementsInterface: {
                assetGuid: "iface-1",
                methodName: "Apply Damage",
              },
            },
            {
              id: "if-1",
              kind: "interface",
              name: "Damageable",
              assetGuid: "",
            },
          ],
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
    projectDocument: { settings: { input: { actions: [], axes: [] } } },
    assetRegistry: {
      list: () => [
        {
          header: {
            guid: "audio-1",
            name: "Jump",
            type: "Audio",
            parentClass: null,
          },
          path: "assets/Jump.audio.babasset",
        },
        {
          header: {
            guid: "tex-1",
            name: "Atlas",
            type: "Texture",
            parentClass: null,
          },
          path: "assets/Atlas.texture.babasset",
        },
      ],
    },
  }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({
    focusDiagnostic: null,
    setFocusDiagnostic: vi.fn(),
  }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
}));

function renderMemberInspector(memberId: string, includeClassPanel = false) {
  return render(
    <AssetOpenProvider
      value={{
        canOpen: (guid) =>
          guid === "struct-stats" || guid === "enum-colors" || guid === "audio-1",
        openAsset: () => {},
      }}
    >
      <PrefabEditingProvider>
        <GraphEditingProvider initialSelectedMemberId={memberId}>
          {includeClassPanel ? (
            <MyClassPanel {...({} as IDockviewPanelProps)} />
          ) : null}
          <InspectorPanel {...({} as IDockviewPanelProps)} />
        </GraphEditingProvider>
      </PrefabEditingProvider>
    </AssetOpenProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
});

function expectDocumentOrder(earlier: HTMLElement, later: HTMLElement) {
  expect(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeGreaterThan(0);
}

describe("Inspector class member details", () => {
  it("shows PinTypePicker for a selected variable", () => {
    renderMemberInspector("var-1", true);
    expect(screen.getByTestId("class-var-type-var-1")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-type")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-variable")).toBeTruthy();
    expect(screen.getByTestId("property-default")).toBeTruthy();
    expect(screen.queryByTestId("property-default")?.getAttribute("type")).not.toBe(
      "text",
    );
    expectDocumentOrder(
      screen.getByTestId("property-name"),
      screen.getByTestId("inspector-member-type"),
    );
    expectDocumentOrder(
      screen.getByTestId("inspector-member-type"),
      screen.getByTestId("inspector-member-container"),
    );
    expectDocumentOrder(
      screen.getByTestId("inspector-member-container"),
      screen.getByTestId("property-default"),
    );
  });

  it("shows separate Inputs and Outputs editors for a selected function", () => {
    renderMemberInspector("fn-1");
    expect(screen.getByTestId("inspector-member-inputs")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-outputs")).toBeTruthy();
    expect(screen.queryByTestId("inspector-member-pins")).toBeNull();
    expect(screen.getByTestId("class-fn-in-add")).toBeTruthy();
    expect(screen.getByTestId("class-fn-out-add")).toBeTruthy();
    expect(screen.getByTestId("property-overridable")).toBeTruthy();
  });

  it("locks Inputs and Outputs for an interface implementation", () => {
    renderMemberInspector("fn-impl");
    expect(screen.getByTestId("inspector-member-interface-impl")).toBeTruthy();
    expect(screen.queryByTestId("class-fn-in-add")).toBeNull();
    expect(screen.queryByTestId("property-overridable")).toBeNull();
  });

  it("shows ScriptInterface AssetPicker for a selected interface", () => {
    renderMemberInspector("if-1");
    expect(screen.getByTestId("inspector-member-interface-pick")).toBeTruthy();
  });

  it("requires a Class Type for object variables and omits a Default", () => {
    renderMemberInspector("var-obj");
    const typeButton = screen.getByTestId("inspector-member-class-type");
    expect(typeButton.textContent).toContain("Hero");
    expect(typeButton.textContent).toContain("Class");
    expect(typeButton.querySelector("[data-type-family]")?.getAttribute("data-type-family")).toBe(
      "class",
    );
    expect(screen.queryByTestId("property-default")).toBeNull();
  });

  it("shows a Structure Type AssetPicker for struct variables", () => {
    renderMemberInspector("var-struct");
    const typeAsset = screen.getByTestId("inspector-member-type-asset");
    expect(typeAsset).toHaveProperty("disabled", false);
    expect(typeAsset.textContent).toContain("struct-stats");
    expect(screen.getByText("Structure Type")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-type-asset-open")).toBeTruthy();
  });

  it("shows an Enum Type AssetPicker for enum variables", () => {
    renderMemberInspector("var-enum");
    const typeAsset = screen.getByTestId("inspector-member-type-asset");
    expect(typeAsset.textContent).toContain("enum-colors");
    expect(screen.getByText("Enum Type")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-type-asset-open")).toBeTruthy();
  });

  it("requires a Class Type for class variables and omits a Default", () => {
    renderMemberInspector("var-class");
    const typeButton = screen.getByTestId("inspector-member-class-type");
    expect(typeButton.textContent).toContain("Actor");
    expect(typeButton.textContent).toContain("Class");
    expect(screen.queryByTestId("inspector-member-class-default")).toBeNull();
    expect(screen.queryByTestId("property-default")).toBeNull();
  });

  it("writes Class Type onto typeClassId and defaultValue for class variables", async () => {
    renderMemberInspector("var-class");
    screen.getByTestId("inspector-member-class-type").click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-GameInstance")).toBeTruthy();
    });
    screen.getByTestId("search-item-GameInstance").click();
    expect(applyGraphChange).toHaveBeenCalled();
    const next = applyGraphChange.mock.calls[0]?.[1];
    expect(next?.members?.find((member) => member.id === "var-class")).toEqual(
      expect.objectContaining({
        typeClassId: "GameInstance",
        defaultValue: "GameInstance",
      }),
    );
  });

  it("shows Single/Array/Map container controls for class variables and locals", () => {
    renderMemberInspector("var-1");
    expect(screen.getByTestId("inspector-member-container")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-container-single")).toBeTruthy();
    cleanup();
    renderMemberInspector("loc-1");
    expect(screen.getByTestId("inspector-member-variable")).toBeTruthy();
    expect(screen.getByTestId("inspector-member-container")).toBeTruthy();
  });

  it("commits Array container and resets the Default for a class variable", () => {
    renderMemberInspector("var-1");
    screen.getByTestId("inspector-member-container-array").click();
    expect(applyGraphChange).toHaveBeenCalled();
    const next = applyGraphChange.mock.calls[0]?.[1];
    expect(next?.members?.find((member) => member.id === "var-1")).toEqual(
      expect.objectContaining({
        typeId: "bool",
        container: "array",
        defaultValue: [],
      }),
    );
  });

  it("commits Map container with an empty default entry list", () => {
    renderMemberInspector("var-1");
    screen.getByTestId("inspector-member-container-map").click();
    expect(applyGraphChange).toHaveBeenCalled();
    const next = applyGraphChange.mock.calls[0]?.[1];
    expect(next?.members?.find((member) => member.id === "var-1")).toEqual(
      expect.objectContaining({
        typeId: "bool",
        container: "map",
        defaultValue: [],
      }),
    );
  });

  it("shows list bars on Array variable rows in the Class tree", () => {
    renderMemberInspector("var-array", true);
    const icon = screen.getByTestId("class-var-type-var-array");
    expect(icon.getAttribute("data-pin-shape")).toBe("list");
  });

  it("shows the map glyph on Map variable rows in the Class tree", () => {
    renderMemberInspector("var-map", true);
    const icon = screen.getByTestId("class-var-type-var-map");
    expect(icon.getAttribute("data-pin-shape")).toBe("map");
  });

  it("places Array default entries below Type and Container", () => {
    renderMemberInspector("var-array");
    expectDocumentOrder(
      screen.getByTestId("inspector-member-type"),
      screen.getByTestId("inspector-member-defaults"),
    );
    expectDocumentOrder(
      screen.getByTestId("inspector-member-container"),
      screen.getByTestId("inspector-member-defaults"),
    );
  });

  it("adds Array default items from Inspector", () => {
    renderMemberInspector("var-array");
    expect(screen.getByTestId("inspector-member-container-array")).toBeTruthy();
    expect(screen.queryByTestId("property-default")).toBeNull();
    expect(screen.queryByTestId("inspector-member-defaults-0-remove")).toBeNull();
    screen.getByTestId("inspector-member-defaults-add").click();
    expect(applyGraphChange).toHaveBeenCalled();
    const added = applyGraphChange.mock.calls[0]?.[1];
    expect(added?.members?.find((member) => member.id === "var-array")).toEqual(
      expect.objectContaining({
        container: "array",
        defaultValue: [{ pitch: 0, yaw: 0, roll: 0 }],
      }),
    );
  });

  it("removes an Array default item", () => {
    renderMemberInspector("var-array-filled");
    expect(screen.getByTestId("inspector-member-defaults-0-remove")).toBeTruthy();
    expect(screen.queryByTestId("inspector-member-type")).toBeTruthy();
    screen.getByTestId("inspector-member-defaults-0-remove").click();
    const next = applyGraphChange.mock.calls[0]?.[1];
    expect(
      next?.members?.find((member) => member.id === "var-array-filled"),
    ).toEqual(
      expect.objectContaining({
        defaultValue: [],
      }),
    );
  });

  it("edits Array rotator items with vector fields and a hidden Item label", () => {
    renderMemberInspector("var-array-filled");
    const pitch = screen.getByTestId("property-item-0-pitch") as HTMLInputElement;
    expect(pitch.value).toBe("1");
    expect(screen.getByTestId("property-item-0-yaw")).toBeTruthy();
    expect(screen.getByTestId("property-item-0-roll")).toBeTruthy();
    const row = screen.getByTestId("property-row-item-0");
    expect(row.getAttribute("data-orientation")).toBe("horizontal");
    expect(
      row.querySelector('[data-slot="field-label"]')?.className,
    ).toMatch(/sr-only/);
    expect(row.className).not.toMatch(/px-2/);
  });

  it("edits Array bool items with a checkbox, not a text field", () => {
    renderMemberInspector("var-array-bool");
    const control = screen.getByTestId("property-item-0");
    expect(control.getAttribute("role")).toBe("checkbox");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.tagName).not.toBe("INPUT");
  });

  it("edits Array float items with a numeric drag field", () => {
    renderMemberInspector("var-array-float");
    const control = screen.getByTestId("property-item-0") as HTMLInputElement;
    expect(control.value).toBe("1.5");
    expect(screen.getByTestId("property-item-0-scrub")).toBeTruthy();
  });

  it("edits Map key and value with type-specific fields", () => {
    renderMemberInspector("var-map-filled");
    const key = screen.getByTestId("property-key-0") as HTMLInputElement;
    expect(key.value).toBe("a");
    expect(screen.queryByTestId("property-key-0-scrub")).toBeNull();
    const value = screen.getByTestId("property-value-0") as HTMLInputElement;
    expect(value.value).toBe("1");
    expect(screen.getByTestId("property-value-0-scrub")).toBeTruthy();
    const keyRow = screen.getByTestId("property-row-key-0");
    expect(keyRow.getAttribute("data-orientation")).toBe("horizontal");
    expect(
      keyRow.querySelector('[data-slot="field-label"]')?.className,
    ).not.toMatch(/sr-only/);
    expect(keyRow.querySelector('[data-slot="field-label"]')?.textContent).toBe(
      "Key",
    );
    expect(
      screen
        .getByTestId("property-row-value-0")
        .querySelector('[data-slot="field-label"]')?.textContent,
    ).toBe("Value");
  });

  it("places Map Key Type between Type and Container, then Default", () => {
    renderMemberInspector("var-map");
    expectDocumentOrder(
      screen.getByTestId("inspector-member-type"),
      screen.getByTestId("inspector-member-key-type"),
    );
    expectDocumentOrder(
      screen.getByTestId("inspector-member-key-type"),
      screen.getByTestId("inspector-member-container"),
    );
    expectDocumentOrder(
      screen.getByTestId("inspector-member-container"),
      screen.getByTestId("inspector-member-defaults"),
    );
  });

  it("shows item and entry counts next to Array and Map add buttons", () => {
    renderMemberInspector("var-array");
    const emptyArray = screen.getByTestId("inspector-member-defaults-count");
    expect(emptyArray.textContent).toBe("0 items");
    expect(screen.getByTestId("inspector-member-defaults-add").parentElement).toBe(
      emptyArray.parentElement,
    );
    cleanup();
    renderMemberInspector("var-array-filled");
    expect(screen.getByTestId("inspector-member-defaults-count").textContent).toBe(
      "1 item",
    );
    cleanup();
    renderMemberInspector("var-map");
    expect(screen.getByTestId("inspector-member-defaults-count").textContent).toBe(
      "0 entries",
    );
    cleanup();
    renderMemberInspector("var-map-filled");
    expect(screen.getByTestId("inspector-member-defaults-count").textContent).toBe(
      "1 entry",
    );
  });

  it("adds and removes Map default entries from Inspector", () => {
    renderMemberInspector("var-map");
    screen.getByTestId("inspector-member-defaults-add").click();
    const added = applyGraphChange.mock.calls[0]?.[1];
    expect(added?.members?.find((member) => member.id === "var-map")).toEqual(
      expect.objectContaining({
        container: "map",
        defaultValue: [{ key: "", value: 0 }],
      }),
    );
    cleanup();
    applyGraphChange.mockClear();
    renderMemberInspector("var-map-filled");
    screen.getByTestId("inspector-member-defaults-0-remove").click();
    const removed = applyGraphChange.mock.calls[0]?.[1];
    expect(
      removed?.members?.find((member) => member.id === "var-map-filled"),
    ).toEqual(expect.objectContaining({ defaultValue: [] }));
  });

  it("shows Class Type for Actor variables and Asset Type for Asset variables", async () => {
    renderMemberInspector("var-actor");
    const classType = screen.getByTestId("inspector-member-class-type");
    expect(classType.textContent).toContain("Actor");
    expect(screen.queryByTestId("property-default")).toBeNull();
    cleanup();
    renderMemberInspector("var-asset");
    const assetType = screen.getByTestId("inspector-member-asset-type");
    expect(assetType.textContent).toContain("Audio");
    expect(screen.getByTestId("property-default").textContent).toContain("Jump");
    expectDocumentOrder(
      screen.getByTestId("inspector-member-type"),
      assetType,
    );
    expectDocumentOrder(assetType, screen.getByTestId("property-default"));
    assetType.click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-Texture")).toBeTruthy();
    });
  });

  it("picks an Asset Default guid filtered to Asset Type", async () => {
    renderMemberInspector("var-asset");
    screen.getByTestId("property-default").click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-audio-1")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-tex-1")).toBeNull();
    screen.getByTestId("search-item-audio-1").click();
    expect(applyGraphChange).toHaveBeenCalled();
    const next = applyGraphChange.mock.calls[0]?.[1];
    expect(next?.members?.find((member) => member.id === "var-asset")).toEqual(
      expect.objectContaining({
        typeId: "asset",
        typeClassId: "Audio",
        defaultValue: "audio-1",
      }),
    );
  });

  it("clears an incompatible Asset Default when Asset Type changes", async () => {
    renderMemberInspector("var-asset");
    screen.getByTestId("inspector-member-asset-type").click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-Texture")).toBeTruthy();
    });
    screen.getByTestId("search-item-Texture").click();
    expect(applyGraphChange).toHaveBeenCalled();
    const next = applyGraphChange.mock.calls[0]?.[1];
    expect(next?.members?.find((member) => member.id === "var-asset")).toEqual(
      expect.objectContaining({
        typeClassId: "Texture",
        defaultValue: "",
      }),
    );
  });
});
