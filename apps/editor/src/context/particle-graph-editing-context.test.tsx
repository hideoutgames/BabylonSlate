import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  createDefaultParticleGraphDocument,
  type ParticleGraphDocument,
} from "@babylonslate/particle-graph";
import {
  ParticleGraphEditingProvider,
  useParticleGraphEditing,
  type ParticleGraphEditingValue,
} from "./particle-graph-editing-context";

const DOC_ID = "particle-graph:assets/Embers.particlegraph.babasset";

const harness = vi.hoisted(() => ({ content: null as unknown }));

vi.mock("./document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: DOC_ID,
        ref: { kind: "particle-graph", path: "assets/Embers.particlegraph.babasset" },
        content: harness.content,
      },
    ],
    assetRegistry: {
      list: () => [
        {
          path: "assets/Sparks.material.babasset",
          header: {
            guid: "mat-sparks",
            name: "Sparks",
            type: "Material",
            payload: { domain: "particle" },
          },
        },
        {
          path: "assets/Rock.material.babasset",
          header: {
            guid: "mat-rock",
            name: "Rock",
            type: "Material",
            payload: { domain: "surface" },
          },
        },
      ],
    },
    registryVersion: 0,
    applyAssetDocumentChange: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
});

let editing: ParticleGraphEditingValue;

function Probe() {
  editing = useParticleGraphEditing();
  return null;
}

const tree = () => (
  <ParticleGraphEditingProvider documentId={DOC_ID}>
    <Probe />
  </ParticleGraphEditingProvider>
);

function mount(doc: ParticleGraphDocument) {
  harness.content = doc;
  const view = render(tree());
  return {
    update(next: ParticleGraphDocument) {
      harness.content = next;
      view.rerender(tree());
    },
  };
}

function embers(): ParticleGraphDocument {
  return { ...createDefaultParticleGraphDocument("Embers"), materialGuid: "mat-sparks" };
}

function withLifetime(doc: ParticleGraphDocument, seconds: number): ParticleGraphDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === "create"
        ? { ...node, properties: { ...node.properties, "default:lifetime": [seconds] } }
        : node,
    ),
  };
}

/** Emitter Output loses its Particle input, which is a validation error. */
function broken(doc: ParticleGraphDocument): ParticleGraphDocument {
  return { ...doc, edges: doc.edges.filter((edge) => edge.targetNodeId !== "output") };
}

describe("ParticleGraphEditingProvider", () => {
  it("keeps the Preview build while nodes are only moved", () => {
    const doc = embers();
    const view = mount(doc);
    const built = editing.previewDocument;
    const key = editing.previewKey;
    expect(built).not.toBeNull();

    view.update({
      ...doc,
      nodes: doc.nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + 40, y: node.position.y - 25 },
      })),
    });
    expect(editing.previewDocument).toBe(built);
    expect(editing.previewKey).toBe(key);

    view.update(withLifetime(doc, 3));
    expect(editing.previewKey).not.toBe(key);
    expect(
      editing.previewDocument?.nodes.find((node) => node.id === "create")?.properties[
        "default:lifetime"
      ],
    ).toEqual([3]);
  });

  it("keeps the last valid build while the graph has errors and follows the Material", () => {
    const doc = embers();
    const view = mount(doc);
    const built = editing.previewDocument;

    view.update(broken(doc));
    expect(editing.errorCount).toBeGreaterThan(0);
    expect(editing.previewDocument).toBe(built);

    view.update({ ...broken(doc), materialGuid: "mat-embers" });
    expect(editing.previewDocument?.materialGuid).toBe("mat-embers");
    expect(editing.previewDocument?.edges).toEqual(doc.edges);
  });

  it("has no Preview build when the graph never validated", () => {
    mount(broken(embers()));
    expect(editing.errorCount).toBeGreaterThan(0);
    expect(editing.previewDocument).toBeNull();
    expect(editing.previewKey).toBeNull();
  });

  it("drops build reports tagged with an older Preview key and clears them on a new build", () => {
    const doc = embers();
    const view = mount(doc);
    const staleKey = editing.previewKey!;
    view.update(withLifetime(doc, 3));

    act(() =>
      editing.reportBuildDiagnostics(staleKey, [
        { code: "particle.compile.buildFailed", message: "Old build", nodeId: "create" },
      ]),
    );
    expect(editing.buildDiagnostics).toEqual([]);

    act(() =>
      editing.reportBuildDiagnostics(editing.previewKey!, [
        {
          code: "particle.compile.buildFailed",
          message: "Create Particle failed",
          nodeId: "create",
          pinId: "lifetime",
        },
      ]),
    );
    expect(editing.buildDiagnostics).toEqual([
      {
        code: "particle.compile.buildFailed",
        message: "Create Particle failed",
        severity: "error",
        nodeId: "create",
        pinId: "lifetime",
      },
    ]);

    // The next build replaces the report instead of inheriting it.
    view.update(withLifetime(doc, 4));
    expect(editing.buildDiagnostics).toEqual([]);
  });

  it("validates the Material against the project's Materials", () => {
    const codes = () => editing.diagnostics.map((row) => row.code);
    const view = mount({ ...embers(), materialGuid: "mat-missing" });
    expect(codes()).toContain("particle.missingMaterial");
    view.update({ ...embers(), materialGuid: "mat-rock" });
    expect(codes()).toContain("particle.materialDomain");
    view.update(embers());
    expect(codes()).not.toContain("particle.missingMaterial");
    expect(codes()).not.toContain("particle.materialDomain");
  });
});
