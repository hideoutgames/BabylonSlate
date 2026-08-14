import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMeshComponent } from "@babylonslate/core";
import {
  PrefabEditingProvider,
  usePrefabEditing,
} from "./prefab-editing-context";

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

function UpdateProbe() {
  const { updateComponent } = usePrefabEditing();
  return (
    <button
      type="button"
      data-testid="update-mesh-kind"
      onClick={() => updateComponent("prefab-mesh", "meshKind", "sphere")}
    >
      Patch
    </button>
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
});
