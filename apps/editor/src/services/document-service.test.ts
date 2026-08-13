import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_BROWSER_ID,
  createDefaultScene,
  createEmptyProject,
  createEmptyLayouts,
  documentId,
  MAIN_CLASS_FILE,
  MAIN_SCENE_FILE,
  migrateLegacyLayout,
} from "@babylonslate/core";
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
        if (kind === "scene") return createDefaultScene();
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
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

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
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

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
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

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

  it("round-trips panel placements in buildLayouts", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const savedPlacement = {
      referencePanelId: "viewport",
      direction: "below" as const,
      height: 180,
    };

    await service.initializeFromProject(projectService, project, {
      documents: {},
      tabOrder: [sceneId],
      activeDocumentId: CONTENT_BROWSER_ID,
      panelPlacements: {
        [sceneId]: { "output-log": savedPlacement },
      },
    });

    service.setPanelPlacement(sceneId, "scene-outliner", {
      referencePanelId: "viewport",
      direction: "left",
      width: 260,
    });

    const layouts = service.buildLayouts();
    expect(layouts.panelPlacements?.[sceneId]?.["output-log"]).toEqual(
      savedPlacement,
    );
    expect(layouts.panelPlacements?.[sceneId]?.["scene-outliner"]).toEqual({
      referencePanelId: "viewport",
      direction: "left",
      width: 260,
    });
  });

  it("closes the previously open scene when opening another scene", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const firstPath = MAIN_SCENE_FILE;
    const secondPath = "assets/level.scene.babasset";
    await service.openDocument(project, {
      kind: "scene",
      path: firstPath,
      label: "main",
    });
    const firstId = documentId({ kind: "scene", path: firstPath });
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    await service.openDocument(project, {
      kind: "graph",
      path: MAIN_CLASS_FILE,
      label: "class",
    });
    await service.openDocument(project, {
      kind: "scene",
      path: secondPath,
      label: "level",
    });
    const secondId = documentId({ kind: "scene", path: secondPath });
    const state = service.getState();
    expect(state.openDocuments.has(firstId)).toBe(false);
    expect(state.openDocuments.has(secondId)).toBe(true);
    expect(state.openDocuments.has(graphId)).toBe(true);
    expect(state.activeDocumentId).toBe(secondId);
  });

  it("restores at most one scene tab from a saved layout", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const firstId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const secondId = documentId({
      kind: "scene",
      path: "assets/level.scene.babasset",
    });
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

    await service.initializeFromProject(projectService, project, {
      documents: {},
      tabOrder: [firstId, graphId, secondId],
      activeDocumentId: firstId,
    });

    const state = service.getState();
    expect(state.tabOrder).toContain(CONTENT_BROWSER_ID);
    expect(state.tabOrder).toContain(graphId);
    expect(state.tabOrder).toContain(secondId);
    expect(state.tabOrder).not.toContain(firstId);
    expect(state.activeDocumentId).toBe(CONTENT_BROWSER_ID);
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

  it("retargets open tabs when a document path changes", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const oldPath = "assets/main.scene.babasset";
    const newPath = "assets/levels/main.scene.babasset";
    await service.openDocument(project, {
      kind: "scene",
      path: oldPath,
      label: "main",
    });
    const oldId = documentId({ kind: "scene", path: oldPath });
    expect(service.getState().openDocuments.has(oldId)).toBe(true);

    service.repathDocument("scene", oldPath, newPath);
    const newId = documentId({ kind: "scene", path: newPath });
    expect(service.getState().openDocuments.has(oldId)).toBe(false);
    expect(service.getState().openDocuments.get(newId)?.ref.path).toBe(newPath);
    expect(service.getState().tabOrder).toContain(newId);
  });

  it("opens Enum documents with the Enum tab suffix", async () => {
    const service = new DocumentService();
    const project = createMockProjectService({
      loadDocument: vi.fn(async () => ({
        kind: "enum",
        name: "Colors",
        members: [{ name: "None", value: 0 }],
      })),
    });
    const path = "assets/colors.babasset";
    await service.openDocument(project, {
      kind: "enum",
      path,
      label: "colors",
    });
    const id = documentId({ kind: "enum", path });
    service.updateAssetDocument(id, {
      kind: "enum",
      name: "Palette",
      members: [
        { name: "None", value: 0 },
        { name: "Red", value: 1 },
      ],
    });
    const doc = service.getDocument(id);
    expect(doc?.dirty).toBe(true);
    expect(doc?.ref.label).toBe("Palette Enum");
    expect((doc?.content as { members: unknown[] }).members).toHaveLength(2);
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
