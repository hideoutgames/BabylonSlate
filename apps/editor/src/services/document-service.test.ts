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
    expect(state.tabOrder[1]).toBe(sceneId);
    expect(state.tabOrder[2]).toBe(graphId);
    expect(state.activeDocumentId).toBe(CONTENT_BROWSER_ID);
  });

  it("pins an open scene immediately after content browser even when other assets were opened first", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    const enumPath = "assets/colors.babasset";
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });

    await service.openDocument(project, {
      kind: "graph",
      path: MAIN_CLASS_FILE,
      label: "class",
    });
    await service.openDocument(project, {
      kind: "enum",
      path: enumPath,
      label: "colors",
    });
    await service.openDocument(project, {
      kind: "scene",
      path: MAIN_SCENE_FILE,
      label: "main",
    });

    const enumId = documentId({ kind: "enum", path: enumPath });
    expect(service.getState().tabOrder).toEqual([
      CONTENT_BROWSER_ID,
      sceneId,
      graphId,
      enumId,
    ]);
    expect(
      service.getScrollableDocumentsOrdered().map((doc) => doc.id),
    ).toEqual([graphId, enumId]);
  });

  it("pins a restored scene after content browser even when saved order listed it last", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

    await service.initializeFromProject(projectService, project, {
      documents: {},
      tabOrder: [graphId, sceneId],
      activeDocumentId: graphId,
    });

    expect(service.getState().tabOrder).toEqual([
      CONTENT_BROWSER_ID,
      sceneId,
      graphId,
    ]);
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

  it("keeps scene dirty when switching active document to Class and back", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const scenePath = MAIN_SCENE_FILE;
    const graphPath = MAIN_CLASS_FILE;
    await service.openDocument(project, {
      kind: "scene",
      path: scenePath,
      label: "main.scene",
    });
    await service.openDocument(project, {
      kind: "graph",
      path: graphPath,
      label: "main.class",
    });
    const sceneId = documentId({ kind: "scene", path: scenePath });
    const graphId = documentId({ kind: "graph", path: graphPath });
    const scene = createDefaultScene();
    scene.name = "Edited";
    service.updateScene(sceneId, scene);
    expect(service.getDocument(sceneId)?.dirty).toBe(true);

    service.setActiveDocument(graphId);
    expect(service.getState().activeDocumentId).toBe(graphId);
    expect(service.getDocument(sceneId)?.dirty).toBe(true);
    expect(
      (service.getDocument(sceneId)?.content as { name?: string })?.name,
    ).toBe("Edited");

    service.setActiveDocument(sceneId);
    expect(service.getDocument(sceneId)?.dirty).toBe(true);
  });

  it("reorders scrollable tabs without moving content browser or the pinned scene", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    const enumPath = "assets/colors.babasset";
    const enumId = documentId({ kind: "enum", path: enumPath });

    await service.openDocument(project, {
      kind: "scene",
      path: MAIN_SCENE_FILE,
      label: "main",
    });
    await service.openDocument(project, {
      kind: "graph",
      path: MAIN_CLASS_FILE,
      label: "class",
    });
    await service.openDocument(project, {
      kind: "enum",
      path: enumPath,
      label: "colors",
    });

    service.reorderClosableTabs(0, 1);

    expect(service.getState().tabOrder).toEqual([
      CONTENT_BROWSER_ID,
      sceneId,
      enumId,
      graphId,
    ]);
  });

  it("does not move a pinned scene when reorderTabs targets its index", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

    await service.openDocument(project, {
      kind: "scene",
      path: MAIN_SCENE_FILE,
      label: "main",
    });
    await service.openDocument(project, {
      kind: "graph",
      path: MAIN_CLASS_FILE,
      label: "class",
    });

    service.reorderTabs(1, 2);

    expect(service.getState().tabOrder).toEqual([
      CONTENT_BROWSER_ID,
      sceneId,
      graphId,
    ]);
  });

  it("keeps the replacement scene pinned after content browser", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const firstId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const secondPath = "assets/level.scene.babasset";
    const secondId = documentId({ kind: "scene", path: secondPath });
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

    await service.openDocument(project, {
      kind: "scene",
      path: MAIN_SCENE_FILE,
      label: "main",
    });
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

    expect(service.getState().openDocuments.has(firstId)).toBe(false);
    expect(service.getState().tabOrder).toEqual([
      CONTENT_BROWSER_ID,
      secondId,
      graphId,
    ]);
  });

  it("unpins the scene slot when the scene tab is closed", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

    await service.openDocument(project, {
      kind: "scene",
      path: MAIN_SCENE_FILE,
      label: "main",
    });
    await service.openDocument(project, {
      kind: "graph",
      path: MAIN_CLASS_FILE,
      label: "class",
    });
    service.closeDocument(sceneId);

    expect(service.getState().tabOrder).toEqual([
      CONTENT_BROWSER_ID,
      graphId,
    ]);
    expect(
      service.getScrollableDocumentsOrdered().map((doc) => doc.id),
    ).toEqual([graphId]);
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
    expect(layouts.showPluginContent).toBe(false);
  });

  it("persists Show Plugin Content in layout.json", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();

    await service.initializeFromProject(projectService, project, {
      documents: {},
      tabOrder: [],
      activeDocumentId: CONTENT_BROWSER_ID,
      showPluginContent: true,
    });

    expect(service.getState().showPluginContent).toBe(true);
    service.setShowPluginContent(false);
    expect(service.buildLayouts().showPluginContent).toBe(false);
    service.setShowPluginContent(true);
    expect(service.buildLayouts().showPluginContent).toBe(true);
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
    expect(state.tabOrder).toEqual([CONTENT_BROWSER_ID, secondId, graphId]);
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
    expect(state.tabOrder).toEqual([CONTENT_BROWSER_ID, secondId, graphId]);
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
    expect(service.getState().openDocuments.get(newId)?.ref.label).toBe(
      "Main Scene",
    );
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

  it("reopens a saved asset-settings Model tab as the model document kind", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const loadDocument = vi.fn(async (kind: string) => {
      if (kind === "scene") return createDefaultScene();
      if (kind === "model") {
        return {
          clipNames: [],
          materialSlots: [{ index: 0, name: "Hero Mat", materialGuid: "mat-1" }],
        };
      }
      return { nodes: [], edges: [] };
    });
    const projectService = {
      loadDocument,
      registry: {
        list: () => [
          {
            path: "assets/hero.babasset",
            header: { type: "Model" },
          },
        ],
      },
    } as unknown as ProjectService;
    const oldId = "asset-settings:assets/hero.babasset";
    const modelId = documentId({ kind: "model", path: "assets/hero.babasset" });
    await service.initializeFromProject(projectService, project, {
      ...createEmptyLayouts(),
      documents: { [oldId]: { preview: true } },
      tabOrder: [oldId],
    });
    expect(service.getState().tabOrder).toContain(modelId);
    expect(service.getState().tabOrder).not.toContain(oldId);
    expect(loadDocument).toHaveBeenCalledWith("model", "assets/hero.babasset");
    expect(service.getDocument(modelId)?.layout).toEqual({ preview: true });
  });

  it("reopens a saved asset-settings Animation tab as the animation document kind", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const loadDocument = vi.fn(async (kind: string) => {
      if (kind === "scene") return createDefaultScene();
      if (kind === "animation") {
        return { clipName: "idle", modelGuid: "model-1", skeletonGuid: null };
      }
      return { nodes: [], edges: [] };
    });
    const projectService = {
      loadDocument,
      registry: {
        list: () => [
          {
            path: "assets/hero_idle.babasset",
            header: { type: "Animation" },
          },
        ],
      },
    } as unknown as ProjectService;
    const oldId = "asset-settings:assets/hero_idle.babasset";
    const animationId = documentId({
      kind: "animation",
      path: "assets/hero_idle.babasset",
    });
    await service.initializeFromProject(projectService, project, {
      ...createEmptyLayouts(),
      documents: { [oldId]: { preview: true } },
      tabOrder: [oldId],
    });
    expect(service.getState().tabOrder).toContain(animationId);
    expect(service.getState().tabOrder).not.toContain(oldId);
    expect(loadDocument).toHaveBeenCalledWith(
      "animation",
      "assets/hero_idle.babasset",
    );
  });

  it("reloads document content from disk without marking dirty", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    await service.initializeFromProject(projectService, project, {
      ...createEmptyLayouts(),
      tabOrder: [graphId],
    });
    service.updateGraph(graphId, { nodes: [{ id: "n1" }], edges: [] } as never);
    expect(service.getDocument(graphId)?.dirty).toBe(true);
    service.replaceLoadedContent(graphId, { nodes: [], edges: [] });
    expect(service.getDocument(graphId)?.dirty).toBe(false);
    expect(service.getDocument(graphId)?.content).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it("closes open tabs whose paths were deleted and keeps Content Browser", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const scenePath = MAIN_SCENE_FILE;
    const enumPath = "assets/colors.babasset";
    await service.openDocument(project, {
      kind: "scene",
      path: scenePath,
      label: "main",
    });
    await service.openDocument(project, {
      kind: "enum",
      path: enumPath,
      label: "colors",
    });
    const sceneId = documentId({ kind: "scene", path: scenePath });
    const enumId = documentId({ kind: "enum", path: enumPath });
    service.setPanelPlacement(enumId, "enum-details", {
      referencePanelId: "enum-preview",
      direction: "right",
      width: 280,
    });
    service.setActiveDocument(enumId);

    const closed = service.closeDocumentsForPaths([enumPath]);
    expect(closed).toEqual([enumId]);
    expect(service.getState().openDocuments.has(enumId)).toBe(false);
    expect(service.getState().openDocuments.has(sceneId)).toBe(true);
    expect(service.getState().tabOrder).toEqual([
      CONTENT_BROWSER_ID,
      sceneId,
    ]);
    expect(service.getState().activeDocumentId).toBe(CONTENT_BROWSER_ID);
    expect(service.getState().panelPlacements[enumId]).toBeUndefined();
  });

  it("closes every open tab under a deleted folder path set", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const spritePath = "assets/fx/spark.sprite.babasset";
    const graphPath = MAIN_CLASS_FILE;
    await service.openDocument(project, {
      kind: "sprite",
      path: spritePath,
      label: "spark",
    });
    await service.openDocument(project, {
      kind: "graph",
      path: graphPath,
      label: "class",
    });
    const spriteId = documentId({ kind: "sprite", path: spritePath });
    const graphId = documentId({ kind: "graph", path: graphPath });

    service.closeDocumentsForPaths([spritePath]);
    expect(service.getState().openDocuments.has(spriteId)).toBe(false);
    expect(service.getState().openDocuments.has(graphId)).toBe(true);
    expect(service.getState().tabOrder[0]).toBe(CONTENT_BROWSER_ID);
  });

  it("patches open document content without clearing dirty", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const projectService = createMockProjectService();
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    await service.initializeFromProject(projectService, project, {
      ...createEmptyLayouts(),
      tabOrder: [graphId],
    });
    service.updateGraph(graphId, {
      nodes: [{ id: "n1", type: "logMessage", position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    } as never);
    expect(service.getDocument(graphId)?.dirty).toBe(true);
    service.patchLoadedContent(graphId, {
      nodes: [{ id: "n1", type: "logMessage", position: { x: 0, y: 0 }, data: { "default:asset": null } }],
      edges: [],
    } as never);
    expect(service.getDocument(graphId)?.dirty).toBe(true);
    expect(
      (service.getDocument(graphId)?.content as { nodes: Array<{ data: unknown }> })
        .nodes[0]?.data,
    ).toEqual({ "default:asset": null });
  });

  it("skips a missing derived Trace tab when restoring layout", async () => {
    const service = new DocumentService();
    const project = createEmptyProject("Test");
    const loadDocument = vi.fn(async (kind: string) => {
      if (kind === "scene") return createDefaultScene();
      if (kind === "trace") {
        throw new Error("Trace file is missing");
      }
      return { nodes: [], edges: [] };
    });
    const projectService = {
      loadDocument,
    } as unknown as ProjectService;
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const traceId = documentId({
      kind: "trace",
      path: "derived/proj/traces/gone.babtrace",
    });
    await service.initializeFromProject(projectService, project, {
      ...createEmptyLayouts(),
      tabOrder: [sceneId, traceId],
    });
    expect(service.getState().tabOrder).toContain(sceneId);
    expect(service.getState().tabOrder).not.toContain(traceId);
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
