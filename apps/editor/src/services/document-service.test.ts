import { describe, expect, it, vi } from "vitest";
import {
  createEmptyProject,
  createEmptyLayouts,
  documentId,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  migrateLegacyLayout,
} from "@babylonslate/shared";
import { DocumentService } from "./document-service";
import { ProjectService } from "./project-service";

function createMockProjectService(
  overrides: Partial<{
    loadDocument: ProjectService["loadDocument"];
  }> = {},
) {
  return {
    loadDocument:
      overrides.loadDocument ??
      vi.fn(async (kind: string) => {
        if (kind === "scene") return { name: "Main", meshes: [] };
        return { nodes: [], edges: [] };
      }),
  } as unknown as ProjectService;
}

describe("DocumentService", () => {
  it("opens scene and graph documents with tab order", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();

    await service.initializeFromProject(
      projectService,
      project,
      createEmptyLayouts(),
    );

    const state = service.getState();
    expect(state.tabOrder).toHaveLength(2);
    expect(state.activeDocumentId).toMatch(/^scene:/);
    expect(service.getOpenDocumentsOrdered()).toHaveLength(2);
  });

  it("marks graph updates as dirty", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();

    await service.initializeFromProject(
      projectService,
      project,
      createEmptyLayouts(),
    );

    const graphId = documentId({ kind: "graph", path: MAIN_GRAPH_FILE });
    service.updateGraph(graphId, {
      nodes: [{ id: "n1", type: "logMessage", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });

    const doc = service.getDocument(graphId);
    expect(doc?.dirty).toBe(true);
  });

  it("reorders tabs horizontally", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();

    await service.initializeFromProject(
      projectService,
      project,
      createEmptyLayouts(),
    );

    service.reorderTabs(0, 1);
    const state = service.getState();
    expect(state.tabOrder[0]).toMatch(/^graph:/);
    expect(state.tabOrder[1]).toMatch(/^scene:/);
  });

  it("builds layout map with tab order", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();

    await service.initializeFromProject(
      projectService,
      project,
      createEmptyLayouts(),
    );

    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    service.setLayout(sceneId, { grid: { root: { type: "branch" } } });

    const layouts = service.buildLayouts();
    expect(layouts.tabOrder).toHaveLength(2);
    expect(layouts.documents[sceneId]).toBeDefined();
  });

  it("closes a document and selects another active tab", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();

    await service.initializeFromProject(
      projectService,
      project,
      createEmptyLayouts(),
    );

    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    service.closeDocument(sceneId);

    const state = service.getState();
    expect(state.tabOrder).toHaveLength(1);
    expect(state.activeDocumentId).toMatch(/^graph:/);
  });
});

describe("layout migration", () => {
  it("migrates legacy flat layout to per-document map", () => {
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const legacy = { grid: { root: { type: "branch" } } };
    const migrated = migrateLegacyLayout(legacy, sceneId);
    expect(migrated.documents[sceneId]).toEqual(legacy);
    expect(migrated.tabOrder).toEqual([sceneId]);
  });
});
