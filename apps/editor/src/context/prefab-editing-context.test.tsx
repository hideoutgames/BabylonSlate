import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMeshComponent } from "@babylonslate/core";
import {
  PrefabEditingProvider,
  usePrefabEditing,
} from "./prefab-editing-context";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";

const applyGraphChange = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.babasset",
  }),
}));

vi.mock("./document-context", () => ({
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
          members: [],
          components: [createMeshComponent("prefab-mesh", "box")],
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
  }),
}));

function SelectionProbe() {
  const {
    selectedId,
    selectedIds,
    setSelectedId,
    setSelectedIds,
    addComponent,
    removeSelected,
    components,
  } = usePrefabEditing();
  return (
    <>
      <span data-testid="prefab-primary-id">{selectedId ?? ""}</span>
      <span data-testid="prefab-selected-ids">{selectedIds.join(",")}</span>
      <button
        type="button"
        data-testid="select-mesh-exclusive"
        onClick={() => setSelectedId("prefab-mesh")}
      >
        Exclusive
      </button>
      <button
        type="button"
        data-testid="select-two-components"
        onClick={() => {
          const extra = components.find((component) => component.id !== "prefab-mesh");
          setSelectedIds(["prefab-mesh", extra?.id ?? "prefab-mesh"]);
        }}
      >
        Multi
      </button>
      <button
        type="button"
        data-testid="add-second-mesh"
        onClick={() => addComponent("MeshComponent")}
      >
        Add
      </button>
      <button type="button" data-testid="remove-selected" onClick={removeSelected}>
        Remove
      </button>
    </>
  );
}

function UpdateProbe() {
  const { updateComponent, updateComponentTransform } = usePrefabEditing();
  return (
    <>
      <button
        type="button"
        data-testid="update-mesh-kind"
        onClick={() => updateComponent("prefab-mesh", "meshKind", "sphere")}
      >
        Patch
      </button>
      <button
        type="button"
        data-testid="update-mesh-transform"
        onClick={() =>
          updateComponentTransform("prefab-mesh", {
            position: [1, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          })
        }
      >
        Move
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
});

describe("PrefabEditingContext updateComponent", () => {
  it("applyGraphChange with the patched component properties", () => {
    render(
      <PrefabEditingProvider>
        <UpdateProbe />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("update-mesh-kind"));
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        components: [
          expect.objectContaining({
            id: "prefab-mesh",
            properties: expect.objectContaining({ meshKind: "sphere" }),
          }),
        ],
      }),
    );
  });

  it("applyGraphChange with a component local transform", () => {
    render(
      <PrefabEditingProvider>
        <UpdateProbe />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("update-mesh-transform"));
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        components: [
          expect.objectContaining({
            id: "prefab-mesh",
            transform: {
              position: [1, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          }),
        ],
      }),
    );
  });
});

describe("PrefabEditingContext selection", () => {
  it("setSelectedId replaces the set and keeps that id primary", () => {
    render(
      <PrefabEditingProvider>
        <SelectionProbe />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("select-mesh-exclusive"));
    expect(screen.getByTestId("prefab-selected-ids").textContent).toBe(
      "prefab-mesh",
    );
    expect(screen.getByTestId("prefab-primary-id").textContent).toBe(
      "prefab-mesh",
    );
  });

  it("selectedId is the last id in selectedIds", () => {
    render(
      <PrefabEditingProvider>
        <SelectionProbe />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("add-second-mesh"));
    fireEvent.click(screen.getByTestId("select-two-components"));
    const ids = screen.getByTestId("prefab-selected-ids").textContent ?? "";
    const primary = screen.getByTestId("prefab-primary-id").textContent ?? "";
    expect(ids.split(",").length).toBe(2);
    expect(ids.endsWith(primary)).toBe(true);
  });

  it("removeSelected deletes every selected local component", () => {
    render(
      <PrefabEditingProvider>
        <SelectionProbe />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("add-second-mesh"));
    fireEvent.click(screen.getByTestId("select-two-components"));
    applyGraphChange.mockClear();
    fireEvent.click(screen.getByTestId("remove-selected"));
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        components: [],
      }),
    );
    expect(screen.getByTestId("prefab-primary-id").textContent).toBe(
      PREFAB_ROOT_ID,
    );
  });
});
