import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
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
            { id: "fn-1", kind: "function", name: "Jump", pins: [] },
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
    assetRegistry: { list: () => [] },
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
    <PrefabEditingProvider>
      <GraphEditingProvider initialSelectedMemberId={memberId}>
        {includeClassPanel ? (
          <MyClassPanel {...({} as IDockviewPanelProps)} />
        ) : null}
        <InspectorPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>
    </PrefabEditingProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
});

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
});
