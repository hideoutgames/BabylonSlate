import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_BROWSER_ID,
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
  it("always pins content browser as the first tab", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();

    const state = service.getState();
    expect(state.tabOrder[0]).toBe(CONTENT_BROWSER_ID);
    expect(state.activeDocumentId).toBe(CONTENT_BROWSER_ID);
  });

  it("restores saved document tabs after content browser on project init", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const graphId = documentId({ kind: "graph", path: MAIN_GRAPH_FILE });

    await service.initializeFromProject(projectService, project, {
      documents: {},
      tabOrder: [sceneId, graphId],
      activeDocumentId: sceneId,
    });

    const state = service.getState();
    expect(state.tabOrder[0]).toBe(CONTENT_BROWSER_ID);
    expect(state.tabOrder).toContain(sceneId);
    expect(state.tabOrder).toContain(graphId);
    expect(state.activeDocumentId).toBe(CONTENT_BROWSER_ID);
  });

  it("cannot close the content browser tab", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();

    service.closeDocument(CONTENT_BROWSER_ID);

    expect(service.getState().tabOrder).toContain(CONTENT_BROWSER_ID);
  });

  it("marks graph updates as dirty", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const graphId = documentId({ kind: "graph", path: MAIN_GRAPH_FILE });

    await service.initializeFromProject(
      projectService,
      project,
      {
        ...createEmptyLayouts(),
        tabOrder: [graphId],
        activeDocumentId: graphId,
      },
    );

    service.updateGraph(graphId, {
      nodes: [{ id: "n1", type: "logMessage", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });

    const doc = service.getDocument(graphId);
    expect(doc?.dirty).toBe(true);
  });

  it("reorders closable tabs without moving content browser", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const graphId = documentId({ kind: "graph", path: MAIN_GRAPH_FILE });

    await service.initializeFromProject(projectService, project, {
      documents: {},
      tabOrder: [sceneId, graphId],
      activeDocumentId: sceneId,
    });

    service.reorderClosableTabs(0, 1);

    const state = service.getState();
    expect(state.tabOrder[0]).toBe(CONTENT_BROWSER_ID);
    expect(state.tabOrder[1]).toBe(graphId);
    expect(state.tabOrder[2]).toBe(sceneId);
  });

  it("builds layout map with tab order and active document", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });

    await service.initializeFromProject(projectService, project, {
      documents: {},
      tabOrder: [sceneId],
      activeDocumentId: CONTENT_BROWSER_ID,
    });

    service.setLayout(sceneId, { grid: { root: { type: "branch" } } });

    const layouts = service.buildLayouts();
    expect(layouts.tabOrder[0]).toBe(CONTENT_BROWSER_ID);
    expect(layouts.documents[sceneId]).toBeDefined();
    expect(layouts.activeDocumentId).toBe(CONTENT_BROWSER_ID);
  });

  it("closes a document and falls back to content browser", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });

    await service.initializeFromProject(projectService, project, {
      documents: {},
      tabOrder: [sceneId],
      activeDocumentId: sceneId,
    });

    service.closeDocument(sceneId);

    const state = service.getState();
    expect(state.tabOrder).toEqual([CONTENT_BROWSER_ID]);
    expect(state.activeDocumentId).toBe(CONTENT_BROWSER_ID);
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
