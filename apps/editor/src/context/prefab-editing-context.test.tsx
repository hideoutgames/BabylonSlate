import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createMeshComponent,
  type SerializedGraph,
  type SerializedTransform,
} from "@babylonslate/core";
import {
  PrefabEditingProvider,
  usePrefabEditing,
} from "./prefab-editing-context";
import { PREFAB_ROOT_ID, type PrefabComponentView } from "../lib/prefab-preview";

const applyGraphChange = vi.hoisted(() => vi.fn<(id: string, graph: SerializedGraph) => Promise<boolean>>(async () => true));
const documentOverrides = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
const workspace = vi.hoisted(() => ({
  documentId: "graph:assets/Hero.class.babasset",
}));

vi.mock("./document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: workspace.documentId }),
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
    ...documentOverrides.value,
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
          const extra = components.find(
            (component) => component.id !== "prefab-mesh",
          );
          setSelectedIds(["prefab-mesh", extra?.id ?? "prefab-mesh"]);
        }}
      >
        Multi
      </button>
      <button
        type="button"
        data-testid="add-second-mesh"
        onClick={() => addComponent({ classId: "MeshComponent" })}
      >
        Add
      </button>
      <button
        type="button"
        data-testid="add-model-mesh"
        onClick={() =>
          addComponent({
            classId: "MeshComponent",
            properties: { assetGuid: "hero" },
          })
        }
      >
        Add model
      </button>
      <button
        type="button"
        data-testid="remove-selected"
        onClick={removeSelected}
      >
        Remove
      </button>
    </>
  );
}

function UpdateProbe() {
  const { updateComponent, updateComponentTransform, commitComponentGizmo } =
    usePrefabEditing();
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
      <button
        type="button"
        data-testid="commit-text-gizmo"
        onClick={() =>
          commitComponentGizmo(
            "prefab-mesh",
            {
              position: [2, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            { wrapWidth: 400, wrapHeight: 80 },
          )
        }
      >
        Wrap
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
  documentOverrides.value = {};
  workspace.documentId = "graph:assets/Hero.class.babasset";
});

function ComponentsProbe({ seen }: { seen: PrefabComponentView[][] }) {
  const { components } = usePrefabEditing();
  seen.push(components);
  return (
    <span data-testid="prefab-component-ids">
      {components.map((component) => component.id).join(",")}
    </span>
  );
}

function ValueProbe({ seen }: { seen: ReturnType<typeof usePrefabEditing>[] }) {
  seen.push(usePrefabEditing());
  return null;
}

describe("PrefabEditingContext inherited components", () => {
  const baseGraph = {
    id: "graph:assets/Base.class.babasset",
    ref: { kind: "graph", path: "assets/Base.class.babasset" },
    content: {
      nodes: [],
      edges: [],
      members: [],
      components: [createMeshComponent("inherited-mesh", "sphere")],
    },
  };

  it("follows a Class reparented in place in the registry", () => {
    const heroGraph = {
      id: "graph:assets/Hero.class.babasset",
      ref: { kind: "graph", path: "assets/Hero.class.babasset" },
      content: {
        nodes: [],
        edges: [],
        members: [],
        components: [createMeshComponent("prefab-mesh", "box")],
      },
    };
    const hero = {
      path: "assets/Hero.class.babasset",
      header: { type: "Class", name: "Hero", parentClass: "Actor" },
    };
    const registry = {
      list: () => [
        hero,
        {
          path: "assets/Base.class.babasset",
          header: { type: "Class", name: "Base", parentClass: "Actor" },
        },
      ],
    };
    documentOverrides.value = {
      openDocuments: [heroGraph, baseGraph],
      assetRegistry: registry,
    };
    const view = render(
      <PrefabEditingProvider>
        <ComponentsProbe seen={[]} />
      </PrefabEditingProvider>,
    );
    expect(screen.getByTestId("prefab-component-ids").textContent).toBe(
      "prefab-mesh",
    );

    hero.header.parentClass = "Base";
    view.rerender(
      <PrefabEditingProvider>
        <ComponentsProbe seen={[]} />
      </PrefabEditingProvider>,
    );
    expect(screen.getByTestId("prefab-component-ids").textContent).toBe(
      "inherited-mesh,prefab-mesh",
    );
  });

  it("keeps the published components when an unrelated edit re-renders the editor", () => {
    const heroGraph = {
      id: "graph:assets/Hero.class.babasset",
      ref: { kind: "graph", path: "assets/Hero.class.babasset" },
      content: {
        nodes: [],
        edges: [],
        members: [],
        components: [createMeshComponent("prefab-mesh", "box")],
      },
    };
    const assets = [
      {
        path: "assets/Hero.class.babasset",
        header: { type: "Class", name: "Hero", parentClass: "Base" },
      },
      {
        path: "assets/Base.class.babasset",
        header: {
          type: "Class",
          name: "Base",
          parentClass: "Actor",
          payload: { components: [createMeshComponent("inherited-mesh", "sphere")] },
        },
      },
    ];
    const seen: PrefabComponentView[][] = [];
    documentOverrides.value = {
      openDocuments: [heroGraph],
      assetRegistry: { list: () => assets.map((asset) => ({ ...asset })) },
    };
    const view = render(
      <PrefabEditingProvider>
        <ComponentsProbe seen={seen} />
      </PrefabEditingProvider>,
    );
    documentOverrides.value = {
      ...documentOverrides.value,
      openDocuments: [heroGraph, { ...baseGraph, id: "sprite:assets/Other.sprite.babasset", ref: { kind: "sprite", path: "assets/Other.sprite.babasset" } }],
    };
    view.rerender(
      <PrefabEditingProvider>
        <ComponentsProbe seen={seen} />
      </PrefabEditingProvider>,
    );
    expect(seen.at(-1)!.map((component) => component.id)).toEqual([
      "inherited-mesh",
      "prefab-mesh",
    ]);
    expect(seen.at(-1)).toBe(seen[0]);
  });

  it("keeps the published value for a Scene workspace while scene and Class documents change", () => {
    workspace.documentId = "scene:assets/Main.scene.babasset";
    const scene = {
      id: "scene:assets/Main.scene.babasset",
      ref: { kind: "scene", path: "assets/Main.scene.babasset" },
      content: { name: "Main", actors: [], settings: {} },
    };
    const seen: ReturnType<typeof usePrefabEditing>[] = [];
    documentOverrides.value = {
      openDocuments: [scene, baseGraph],
      assetRegistry: {
        list: () => [
          {
            path: "assets/Base.class.babasset",
            header: { type: "Class", name: "Base", parentClass: "Actor" },
          },
        ],
      },
    };
    const view = render(
      <PrefabEditingProvider>
        <ValueProbe seen={seen} />
      </PrefabEditingProvider>,
    );
    documentOverrides.value = {
      ...documentOverrides.value,
      openDocuments: [
        { ...scene, content: { ...scene.content, name: "Main Edited" } },
        {
          ...baseGraph,
          content: {
            ...baseGraph.content,
            components: [createMeshComponent("inherited-mesh", "cylinder")],
          },
        },
      ],
    };
    view.rerender(
      <PrefabEditingProvider>
        <ValueProbe seen={seen} />
      </PrefabEditingProvider>,
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(seen[0]);
  });
});

function BatchTransformProbe({
  changes,
}: {
  changes: Array<{ componentId: string; transform: SerializedTransform }>;
}) {
  const { commitComponentTransforms } = usePrefabEditing();
  return (
    <button type="button" onClick={() => commitComponentTransforms?.(changes)}>
      Commit Transforms
    </button>
  );
}

function ShapeEditProbe() {
  const { commitComponentProperties } = usePrefabEditing();
  return <button type="button" onClick={() => commitComponentProperties("path", {
    points: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], closed: true,
  })}>Commit Shape</button>;
}

it("persists a spline gesture in one graph edit while retaining its transform and other properties", () => {
  const transform: SerializedTransform = { position: [4, 3, 2], rotation: [0, 0, 0, 1], scale: [2, 3, 4] };
  const path = { id: "path", classId: "SplineComponent", parentId: "prefab-mesh", transform,
    properties: { points: [[0, 0, 0], [0, 0, 5]], curvature: 0.5, closed: false } };
  const mesh = createMeshComponent("prefab-mesh", "box");
  documentOverrides.value = { openDocuments: [{
    id: "graph:assets/Hero.class.babasset",
    ref: { kind: "graph", path: "assets/Hero.class.babasset" },
    content: { nodes: [], edges: [], members: [], components: [mesh, path] },
  }] };
  render(<PrefabEditingProvider><ShapeEditProbe /></PrefabEditingProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Commit Shape" }));
  expect(applyGraphChange).toHaveBeenCalledOnce();
  const next = applyGraphChange.mock.calls[0]![1];
  expect(next.components?.[1]).toEqual({ ...path, properties: {
    points: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], closed: true, curvature: 0.5,
  } });
  expect(next.components?.[0]).toMatchObject(mesh);
  expect(path.properties.points).toEqual([[0, 0, 0], [0, 0, 5]]);
});

describe("PrefabEditingContext batch transforms", () => {
  it("persists inherited and local drops together without changing other components", () => {
    const inherited = createMeshComponent("inherited-mesh", "sphere");
    const local = {
      ...createMeshComponent("local-mesh", "box"),
      parentId: "inherited-mesh",
    };
    const untouched = createMeshComponent("untouched-mesh", "cylinder");
    documentOverrides.value = {
      openDocuments: [
        {
          id: "graph:assets/Hero.class.babasset",
          ref: { kind: "graph", path: "assets/Hero.class.babasset" },
          content: {
            nodes: [],
            edges: [],
            members: [],
            components: [local, untouched],
          },
        },
        {
          id: "graph:assets/Base.class.babasset",
          ref: { kind: "graph", path: "assets/Base.class.babasset" },
          content: {
            nodes: [],
            edges: [],
            members: [],
            components: [inherited],
          },
        },
      ],
      assetRegistry: {
        list: () => [
          {
            path: "assets/Hero.class.babasset",
            header: { type: "Class", name: "Hero", parentClass: "Base" },
          },
          {
            path: "assets/Base.class.babasset",
            header: { type: "Class", name: "Base", parentClass: "Actor" },
          },
        ],
      },
    };
    render(
      <PrefabEditingProvider>
        <BatchTransformProbe
          changes={[
            {
              componentId: "inherited-mesh",
              transform: {
                position: [0, -2, 0],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1],
              },
            },
            {
              componentId: "local-mesh",
              transform: {
                position: [3, -7, 4],
                rotation: [0, 1, 0, 0],
                scale: [2, 3, 4],
              },
            },
          ]}
        />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Commit Transforms" }));
    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        components: [
          {
            ...inherited,
            parentId: null,
            transform: {
              position: [0, -2, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
          {
            ...local,
            transform: {
              position: [3, -7, 4],
              rotation: [0, 1, 0, 0],
              scale: [2, 3, 4],
            },
          },
          {
            ...untouched,
            parentId: null,
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
        ],
      }),
    );
  });

  it("leaves the document clean when no component can move", () => {
    render(
      <PrefabEditingProvider>
        <BatchTransformProbe changes={[]} />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Commit Transforms" }));
    expect(applyGraphChange).not.toHaveBeenCalled();
  });
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

  it("applyGraphChange with wrap properties and transform in one write", () => {
    render(
      <PrefabEditingProvider>
        <UpdateProbe />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("commit-text-gizmo"));
    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        components: [
          expect.objectContaining({
            id: "prefab-mesh",
            properties: expect.objectContaining({
              wrapWidth: 400,
              wrapHeight: 80,
            }),
            transform: {
              position: [2, 0, 0],
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

  it("merges assetGuid onto MeshComponent defaults and parents under the selected row", () => {
    render(
      <PrefabEditingProvider>
        <SelectionProbe />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("select-mesh-exclusive"));
    applyGraphChange.mockClear();
    fireEvent.click(screen.getByTestId("add-model-mesh"));
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        components: expect.arrayContaining([
          expect.objectContaining({
            classId: "MeshComponent",
            parentId: "prefab-mesh",
            properties: expect.objectContaining({
              meshKind: "box",
              assetGuid: "hero",
            }),
          }),
        ]),
      }),
    );
  });

  it("selects the component that was just added", () => {
    render(
      <PrefabEditingProvider>
        <SelectionProbe />
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("add-model-mesh"));
    const primary = screen.getByTestId("prefab-primary-id").textContent ?? "";
    expect(primary).toMatch(/^prefab-component-/);
    expect(screen.getByTestId("prefab-selected-ids").textContent).toBe(primary);
  });
});
