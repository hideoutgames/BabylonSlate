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
  type DocumentKind,
} from "@babylonslate/core";
import {
  DocumentService,
  documentKindsRevision,
  type DocumentRevisions,
} from "./document-service";
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
  it("protects document content and revisions while independent authoring owners hold leases", async () => {
    const service = new DocumentService();
    const project = createMockProjectService();
    const sceneId = await service.openDocument(project, { kind: "scene", path: MAIN_SCENE_FILE, label: "Main" });
    const graphId = await service.openDocument(project, { kind: "graph", path: MAIN_CLASS_FILE, label: "Class" });
    const assetId = await service.openDocument(project, { kind: "material", path: "assets/Test.material.babasset", label: "Material" });
    const before = service.getOpenDocumentsOrdered().map(doc => ({ ...doc }));
    const revisions = service.getRevisions();
    const changes: Array<string | null> = [];
    const unsubscribe = service.onAuthoringLockChange(() => { changes.push(service.getAuthoringLock().reason); });
    const releaseSession = service.lockAuthoring("Session owns the baseline.");
    const releaseReload = service.lockAuthoring("Reload pending.");
    const mutations = [
      () => service.updateScene(sceneId, { ...createDefaultScene(), name: "Changed" }),
      () => service.updateGraph(graphId, { nodes: [], edges: [] }),
      () => service.updateAssetDocument(assetId, { name: "Changed" }),
      () => service.replaceLoadedContent(sceneId, createDefaultScene()),
      () => service.patchLoadedContent(graphId, { nodes: [], edges: [] }),
    ];
    for (const mutation of mutations) expect(mutation).toThrow("Session owns the baseline.");
    expect(service.getOpenDocumentsOrdered()).toEqual(before);
    expect(service.getRevisions()).toBe(revisions);
    releaseSession();
    releaseSession();
    expect(service.getAuthoringLock()).toMatchObject({ readOnly: true, reason: "Reload pending." });
    expect(() => service.updateGraph(graphId, { nodes: [], edges: [] })).toThrow("Reload pending.");
    releaseReload();
    expect(service.getAuthoringLock()).toMatchObject({ readOnly: false, reason: null });
    expect(changes).toEqual(["Session owns the baseline.", "Session owns the baseline.", "Reload pending.", null]);
    unsubscribe();
    service.updateGraph(graphId, { nodes: [], edges: [], actorDefaults: { properties: { accepted: true } } });
    expect(service.getDocument(graphId)).toMatchObject({ dirty: true, content: { actorDefaults: { properties: { accepted: true } } } });
  });

  it("lets a previously captured safe save acknowledge its content while authoring is locked", async () => {
    const service = new DocumentService();
    const id = await service.openDocument(createMockProjectService(), { kind: "scene", path: MAIN_SCENE_FILE, label: "Main" });
    service.updateScene(id, { ...createDefaultScene(), name: "Unsaved baseline" });
    const saved = service.getDirtyDocuments().map(doc => ({ ...doc }));
    const release = service.lockAuthoring("Session owns the baseline.");
    service.setLayout(id, { camera: "editor" });
    service.markAllClean(saved);
    expect(service.getDocument(id)).toMatchObject({ content: { name: "Unsaved baseline" }, dirty: false, layout: { camera: "editor" } });
    expect(service.getAuthoringLock().readOnly).toBe(true);
    release();
  });

  it("protects the source scene and dirty tabs from close, reset, and repath while allowing clean asset navigation", async () => {
    const service = new DocumentService();
    const project = createMockProjectService();
    const scene = await service.openDocument(project, { kind: "scene", path: MAIN_SCENE_FILE, label: "Main" });
    const graph = await service.openDocument(project, { kind: "graph", path: MAIN_CLASS_FILE, label: "Class" });
    const dirtyGraph = await service.openDocument(project, { kind: "graph", path: "assets/Dirty.babasset", label: "Dirty" });
    service.updateGraph(dirtyGraph, { nodes: [], edges: [], actorDefaults: { generateHitEvents: true } });
    const release = service.lockAuthoring("Stop the session first");
    expect(() => service.closeDocument(scene)).toThrow("Stop the session first");
    expect(() => service.closeDocument(dirtyGraph)).toThrow("Stop the session first");
    expect(() => service.closeDocumentsForPaths([MAIN_CLASS_FILE])).toThrow("Stop the session first");
    expect(() => service.repathDocument("graph", MAIN_CLASS_FILE, "assets/Renamed.babasset")).toThrow("Stop the session first");
    await expect(service.initializeFromProject(project, createEmptyProject("Other"), createEmptyLayouts())).rejects.toThrow("Stop the session first");
    expect(service.getDocument(scene)).toBeDefined();
    expect(service.getDocument(dirtyGraph)?.dirty).toBe(true);
    service.closeDocument(graph);
    expect(service.getDocument(graph)).toBeUndefined();
    const reopened = await service.openDocument(project, { kind: "graph", path: MAIN_CLASS_FILE, label: "Class" });
    expect(service.getDocument(reopened)).toBeDefined();
    release();
  });

  it("rejects a delayed replacement scene before its close callback after crossing a session lock", async () => {
    const service = new DocumentService();
    const original = await service.openDocument(createMockProjectService(), { kind: "scene", path: MAIN_SCENE_FILE, label: "Main" });
    let finishRead!: (value: ReturnType<typeof createDefaultScene>) => void;
    const project = createMockProjectService({ loadDocument: () => new Promise(resolve => { finishRead = resolve; }) });
    const beforeCommit = vi.fn(() => { service.closeDocument(original); });
    const loading = service.openDocument(project, { kind: "scene", path: "assets/Other.babasset", label: "Other" }, null, true, { beforeCommit });
    const release = service.lockAuthoring("Protected baseline");
    release();
    finishRead(createDefaultScene());
    await expect(loading).rejects.toThrow("crossed an authoring lock");
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(service.getDocument(original)).toBeDefined();
    expect(service.getOpenDocumentsOrdered().filter(doc => doc.ref.kind === "scene")).toHaveLength(1);
  });

  it.each(["open", "activate"] as const)("keeps background utility trees dirty and promotes their existing working copy on %s", async (action) => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const ref = { kind: "data-tree" as const, path: "assets/Sword.datatree.babasset", label: "Sword" };
    const original = { kind: "dataTree", defaultDefinitionGuid: "item", entries: [{ id: "row", parentId: null, name: "Sword", values: { Price: 5 } }] };
    const project = createMockProjectService({ loadDocument: vi.fn(async () => original) });
    const id = await service.openDocument(project, ref, { panel: "object" }, false, { background: true });
    service.setPanelPlacement(id, "data-tree-details", { referencePanelId: "data-tree", direction: "right", width: 240 });
    const working = service.getDocument(id)!;
    const edited = { ...original, entries: [{ ...original.entries[0]!, values: { Price: 12 } }] };
    service.updateAssetDocument(id, edited);
    expect(service.getOpenDocumentsOrdered()).toContain(working);
    expect(service.getClosableDocumentsOrdered()).toContain(working);
    expect(service.getDirtyDocuments()).toEqual([working]);
    expect(service.getScrollableDocumentsOrdered()).toEqual([]);
    expect(service.getState().activeDocumentId).toBe(CONTENT_BROWSER_ID);
    expect(service.buildLayouts()).toMatchObject({ documents: {}, tabOrder: [CONTENT_BROWSER_ID] });
    expect(service.buildLayouts().panelPlacements?.[id]).toBeUndefined();
    const tabsRevision = service.getTabsRevision();
    if (action === "open") await service.openDocument(project, ref);
    else service.setActiveDocument(id);
    expect(service.getDocument(id)).toBe(working);
    expect(working).toMatchObject({ content: edited, dirty: true });
    expect(working.background).not.toBe(true);
    expect(service.getTabsRevision()).toBeGreaterThan(tabsRevision);
    expect(service.getState().activeDocumentId).toBe(id);
    expect(service.buildLayouts().tabOrder).toEqual([CONTENT_BROWSER_ID, id]);
    service.markAllClean(service.getDirtyDocuments().map((doc) => ({ ...doc })));
    expect(service.getDirtyDocuments()).toEqual([]);
    // Ensuring a tree already open in its own tab never hides it again.
    await service.openDocument(project, ref, null, false, { background: true });
    expect(working.background).not.toBe(true);
  });

  it.each([true, false])("preserves a foreground opening and shared edits when a background read races it (slow background: %s)", async (slowBackground) => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const ref = { kind: "data-tree" as const, path: "assets/Sword.datatree.babasset", label: "Sword" };
    const original = { kind: "dataTree", defaultDefinitionGuid: "item", entries: [{ id: "row", parentId: null, name: "Sword", values: { Price: 5 } }] };
    let finish!: (value: Record<string, unknown>) => void;
    const project = createMockProjectService({ loadDocument: vi.fn()
      .mockImplementationOnce(() => new Promise<Record<string, unknown>>((resolve) => { finish = resolve; }))
      .mockResolvedValue(original) });
    const slow = service.openDocument(project, ref, null, !slowBackground, { background: slowBackground });
    const id = await service.openDocument(project, ref, null, slowBackground, { background: !slowBackground });
    const working = service.getDocument(id)!;
    service.updateAssetDocument(id, { ...original, entries: [{ ...original.entries[0]!, values: { Price: 20 } }] });
    finish(original);
    await slow;
    expect(service.getDocument(id)).toBe(working);
    expect(working).toMatchObject({ dirty: true, content: { entries: [{ values: { Price: 20 } }] } });
    expect(working.background).not.toBe(true);
    expect(service.getState().activeDocumentId).toBe(id);
    expect(service.buildLayouts().tabOrder).toEqual([CONTENT_BROWSER_ID, id]);
  });

  it("reorders only visible tabs while keeping background edits available for save and cleanup", async () => {
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const project = createMockProjectService();
    const open = (name: string, background = false) => service.openDocument(project, {
      kind: "data-tree", path: `assets/${name}.datatree.babasset`, label: name,
    }, null, !background, { background });
    const first = await open("First");
    const background = await open("Shared", true);
    const second = await open("Second");
    service.updateAssetDocument(background, { kind: "dataTree", defaultDefinitionGuid: "item", entries: [{ id: "row", parentId: null, name: "Sword", values: { Price: 15 } }] });
    service.reorderClosableTabs(0, 1);
    expect(service.getScrollableDocumentsOrdered().map((doc) => doc.id)).toEqual([second, first]);
    expect(service.buildLayouts().tabOrder).toEqual([CONTENT_BROWSER_ID, second, first]);
    expect(service.getDirtyDocuments().map((doc) => doc.id)).toEqual([background]);
    service.closeDocument(second);
    expect(service.getState().activeDocumentId).toBe(CONTENT_BROWSER_ID);
    service.closeDocument(background);
    expect(service.getOpenDocumentsOrdered().map((doc) => doc.id)).toEqual([CONTENT_BROWSER_ID, first]);
    expect(service.getDirtyDocuments()).toEqual([]);
  });

  it("keeps edits and one tab when concurrent reads of the same document finish out of order", async () => {
    const service = new DocumentService();
    const ref = { kind: "graph" as const, path: MAIN_CLASS_FILE, label: "Main" };
    let finishSlowRead!: (value: { nodes: []; edges: [] }) => void;
    const loadDocument = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishSlowRead = resolve; }))
      .mockResolvedValue({ nodes: [], edges: [] });
    const project = createMockProjectService({ loadDocument });
    const opened = vi.fn();
    service.onIdentityChange(opened);
    const slow = service.openDocument(project, ref);
    const id = await service.openDocument(project, ref);
    const entry = service.getDocument(id);
    const edited = { nodes: [], edges: [], properties: { name: "Unsaved" } };
    service.updateGraph(id, edited);
    const revisions = service.getRevisions();
    finishSlowRead({ nodes: [], edges: [] });
    expect(await slow).toBe(id);
    expect(service.getDocument(id)).toBe(entry);
    expect(entry).toMatchObject({ dirty: true, content: edited });
    expect(service.getRevisions()).toBe(revisions);
    expect(service.getState().tabOrder.filter((tab) => tab === id)).toEqual([id]);
    expect(opened).toHaveBeenCalledOnce();
  });

  it("does not commit a pending asset read into a replacement project", async () => {
    const service = new DocumentService();
    let finishRead!: (value: { nodes: []; edges: [] }) => void;
    const previous = service.openDocument(createMockProjectService({
      loadDocument: vi.fn(() => new Promise<{ nodes: []; edges: [] }>((resolve) => { finishRead = resolve; })),
    }), { kind: "graph", path: MAIN_CLASS_FILE, label: "Old project Class" });
    const rejected = expect(previous).rejects.toMatchObject({ name: "AbortError" });
    await service.initializeFromProject(createMockProjectService(), createEmptyProject("Next"), createEmptyLayouts());
    finishRead({ nodes: [], edges: [] });
    await rejected;
    expect(service.getOpenDocumentsOrdered().map((doc) => doc.id)).toEqual([CONTENT_BROWSER_ID]);
  });

  it("waits for blocking UI before reading a scene and only closes the previous scene after success", async () => {
    const service = new DocumentService();
    const previous = { kind: "scene" as const, path: "assets/Previous.scene.babasset", label: "Previous" };
    const next = { kind: "scene" as const, path: "assets/Next.scene.babasset", label: "Next" };
    await service.openDocument(createMockProjectService(), previous);
    let paint!: () => void;
    let read!: (scene: ReturnType<typeof createDefaultScene>) => void;
    const loadDocument = vi.fn(() => new Promise<ReturnType<typeof createDefaultScene>>((resolve) => { read = resolve; }));
    const beforeCommit = vi.fn(() => {
      expect(service.getDocument(documentId(previous))).toBeDefined();
    });
    const opened = service.openDocument(createMockProjectService({ loadDocument }), next, null, true, {
      beforeLoad: () => new Promise<void>((resolve) => { paint = resolve; }),
      beforeCommit,
    });
    expect(loadDocument).not.toHaveBeenCalled();
    paint();
    await vi.waitFor(() => expect(loadDocument).toHaveBeenCalledOnce());
    expect(service.getActiveDocument()?.id).toBe(documentId(previous));
    expect(beforeCommit).not.toHaveBeenCalled();
    read({ ...createDefaultScene(), name: "Next" });
    await opened;
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(service.getActiveDocument()?.content).toMatchObject({ name: "Next" });
    expect(service.getDocument(documentId(previous))).toBeUndefined();
  });

  it("keeps the current scene and dirty revision when a replacement read fails", async () => {
    const service = new DocumentService();
    const previous = { kind: "scene" as const, path: "assets/Previous.scene.babasset", label: "Previous" };
    await service.openDocument(createMockProjectService(), previous);
    const edited = { ...createDefaultScene(), name: "Edited" };
    service.updateScene(documentId(previous), edited);
    const beforeCommit = vi.fn();
    const failure = new Error("Scene read failed");
    await expect(service.openDocument(createMockProjectService({ loadDocument: vi.fn().mockRejectedValue(failure) }),
      { kind: "scene", path: "assets/Missing.scene.babasset", label: "Missing" }, null, true, { beforeCommit },
    )).rejects.toBe(failure);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(service.getActiveDocument()).toMatchObject({ id: documentId(previous), dirty: true, content: edited });
  });

  it("does not let a cancelled late read replace a newer exclusive scene", async () => {
    const service = new DocumentService();
    const controller = new AbortController();
    let finishOldRead!: (scene: ReturnType<typeof createDefaultScene>) => void;
    const oldRead = vi.fn(() => new Promise<ReturnType<typeof createDefaultScene>>((resolve) => { finishOldRead = resolve; }));
    const beforeCommit = vi.fn();
    const old = service.openDocument(createMockProjectService({ loadDocument: oldRead }),
      { kind: "scene", path: "assets/Old.scene.babasset", label: "Old" }, null, true, { signal: controller.signal, beforeCommit });
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    const next = { kind: "scene" as const, path: "assets/New.scene.babasset", label: "New" };
    await service.openDocument(createMockProjectService(), next);
    finishOldRead({ ...createDefaultScene(), name: "Old" });
    await rejected;
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(service.getActiveDocument()?.id).toBe(documentId(next));
    expect(service.getOpenDocumentsOrdered().filter((doc) => doc.ref.kind === "scene")).toHaveLength(1);
  });

  it("H6: only clears the saved document revision, retaining edits made during a save", async () => {
    const service = new DocumentService();
    const project = createMockProjectService();
    for (const name of ["Main", "Other", "Control"]) {
      await service.openDocument(project, { kind: "graph", path: `assets/${name}.class.babasset`, label: name });
    }
    const main = "graph:assets/Main.class.babasset";
    const other = "graph:assets/Other.class.babasset";
    const control = "graph:assets/Control.class.babasset";
    service.updateGraph(main, { nodes: [], edges: [], members: [{ id: "saved", kind: "event", name: "Saved revision" }] });
    service.updateGraph(control, { nodes: [], edges: [] });
    const saved = service.getDirtyDocuments().map((doc) => ({ ...doc }));
    service.updateGraph(main, { nodes: [], edges: [], members: [{ id: "new", kind: "event", name: "New revision" }] });
    service.updateGraph(other, { nodes: [], edges: [] });
    service.markAllClean(saved);
    expect(service.getDocument(main)?.dirty).toBe(true);
    expect(service.getDocument(other)?.dirty).toBe(true);
    expect(service.getDocument(control)?.dirty).toBe(false);
    expect(saved.find((doc) => doc.id === main)?.content).toMatchObject({ members: [{ name: "Saved revision" }] });
    const newerSave = service.getDirtyDocuments().map((doc) => ({ ...doc }));
    service.markAllClean(newerSave);
    expect(service.getDocument(main)?.dirty).toBe(false);
    // A slower write of the old revision can finish after the newer save.
    service.markAllClean(saved);
    expect(service.getDocument(main)?.dirty).toBe(true);
  });
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

  it("keeps SceneLayer tabs open beside a world scene and hosts them as 2D editor scenes", async () => {
    const { createDefaultSceneLayer } = await import("@babylonslate/core");
    const service = new DocumentService();
    service.ensureContentBrowserTab();
    const layer = createDefaultSceneLayer();
    layer.name = "HUD";
    const project = createMockProjectService({
      loadDocument: vi.fn(async (kind: string) => {
        if (kind === "scene") return createDefaultScene();
        if (kind === "scene-layer") return layer;
        return { nodes: [], edges: [] };
      }),
    });
    const sceneId = documentId({ kind: "scene", path: MAIN_SCENE_FILE });
    const layerId = documentId({
      kind: "scene-layer",
      path: "assets/Hud.scenelayer.babasset",
    });
    await service.openDocument(project, {
      kind: "scene",
      path: MAIN_SCENE_FILE,
      label: "main",
    });
    await service.openDocument(project, {
      kind: "scene-layer",
      path: "assets/Hud.scenelayer.babasset",
      label: "HUD",
    });
    expect(service.getState().openDocuments.has(sceneId)).toBe(true);
    expect(service.getState().openDocuments.has(layerId)).toBe(true);
    const opened = service.getDocument(layerId);
    expect(opened?.ref.kind).toBe("scene-layer");
    expect((opened?.content as { viewportMode?: string })?.viewportMode).toBe(
      "2d",
    );
    service.updateScene(layerId, {
      ...(opened?.content as ReturnType<typeof createDefaultScene>),
      name: "Pause",
    });
    expect(service.getDocument(layerId)?.dirty).toBe(true);
    expect(
      (service.getDocument(layerId)?.content as { name?: string })?.name,
    ).toBe("Pause");
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

describe("DocumentService revisions", () => {
  const HERO = "assets/Hero.class.babasset";
  const HELPER = "assets/Helper.class.babasset";
  const STONE = "assets/Stone.material.babasset";

  /** Content Browser, Main scene, two Classes and a Material; Stone is active. */
  async function openFixture() {
    const service = new DocumentService();
    const project = createMockProjectService();
    service.ensureContentBrowserTab();
    const open = (kind: "scene" | "graph" | "material", path: string) =>
      service.openDocument(project, { kind, path, label: path });
    const scene = await open("scene", MAIN_SCENE_FILE);
    const hero = await open("graph", HERO);
    const helper = await open("graph", HELPER);
    const stone = await open("material", STONE);
    const heroContent = service.getDocument(hero)!.content!;
    return { service, project, scene, hero, helper, stone, heroContent };
  }
  type Fixture = Awaited<ReturnType<typeof openFixture>>;

  function changedKinds(before: DocumentRevisions, after: DocumentRevisions) {
    return Object.keys(after)
      .filter((kind) => after[kind as DocumentKind] !== before[kind as DocumentKind])
      .sort();
  }

  const editedGraph = {
    nodes: [],
    edges: [],
    members: [{ id: "launch", kind: "function" as const, name: "Launch" }],
  };

  const cases: Array<{
    name: string;
    setup?: (f: Fixture) => unknown;
    act: (f: Fixture) => unknown;
    kinds: string[];
    tabs: boolean;
  }> = [
    { name: "a Class edit", act: (f) => f.service.updateGraph(f.hero, editedGraph), kinds: ["graph"], tabs: false },
    {
      name: "Undo back to an earlier content object",
      setup: (f) => f.service.updateGraph(f.hero, editedGraph),
      act: (f) => f.service.updateGraph(f.hero, f.heroContent as never),
      kinds: ["graph"],
      tabs: false,
    },
    {
      name: "a Scene edit",
      act: (f) => f.service.updateScene(f.scene, { ...createDefaultScene(), name: "Edited" }),
      kinds: ["scene"],
      tabs: false,
    },
    {
      name: "a Material edit",
      act: (f) => f.service.updateAssetDocument(f.stone, { domain: "postProcess" }),
      kinds: ["material"],
      tabs: false,
    },
    {
      name: "a quiet patch",
      act: (f) => f.service.patchLoadedContent(f.scene, { ...createDefaultScene(), name: "Synced" }),
      kinds: ["scene"],
      tabs: false,
    },
    {
      name: "a reload from disk",
      act: (f) => f.service.replaceLoadedContent(f.hero, { nodes: [], edges: [] }),
      kinds: ["graph"],
      tabs: false,
    },
    { name: "a layout capture", act: (f) => f.service.setLayout(f.hero, { grid: {} }), kinds: ["graph"], tabs: false },
    {
      name: "capturing an equal layout again",
      setup: (f) => f.service.setLayout(f.hero, { grid: { root: "graph" } }),
      act: (f) => f.service.setLayout(f.hero, { grid: { root: "graph" } }),
      kinds: [],
      tabs: false,
    },
    {
      name: "Save clearing an edit",
      setup: (f) => f.service.updateGraph(f.hero, editedGraph),
      act: (f) => f.service.markAllClean(f.service.getDirtyDocuments().map((doc) => ({ ...doc }))),
      kinds: ["graph"],
      tabs: false,
    },
    { name: "Save with nothing dirty", act: (f) => f.service.markAllClean([]), kinds: [], tabs: false },
    {
      name: "opening a tab",
      act: (f) => f.service.openDocument(f.project, { kind: "enum", path: "assets/Mood.enum.babasset", label: "Mood" }),
      kinds: ["enum"],
      tabs: true,
    },
    {
      name: "opening an already open tab",
      act: (f) => f.service.openDocument(f.project, { kind: "graph", path: HERO, label: "Hero" }),
      kinds: [],
      tabs: true,
    },
    { name: "closing a tab", act: (f) => f.service.closeDocument(f.helper), kinds: ["graph"], tabs: true },
    {
      name: "a rename",
      act: (f) => f.service.repathDocument("graph", HERO, "assets/Champion.class.babasset"),
      kinds: ["graph"],
      tabs: true,
    },
    { name: "switching tabs", act: (f) => f.service.setActiveDocument(f.hero), kinds: [], tabs: true },
    { name: "selecting the active tab", act: (f) => f.service.setActiveDocument(f.stone), kinds: [], tabs: false },
    // Scrollable tabs are Hero, Helper, Stone: the Material moves first.
    { name: "moving a tab", act: (f) => f.service.reorderClosableTabs(2, 0), kinds: ["material"], tabs: true },
    { name: "a refused move of the pinned scene", act: (f) => f.service.reorderTabs(1, 2), kinds: [], tabs: false },
    {
      name: "opening another project",
      act: (f) => f.service.initializeFromProject(f.project, createEmptyProject("Next"), createEmptyLayouts()),
      kinds: ["content-browser", "graph", "material", "scene"],
      tabs: true,
    },
  ];

  it.each(cases)("$name advances exactly the kinds it changes", async ({ setup, act, kinds, tabs }) => {
    const fixture = await openFixture();
    await setup?.(fixture);
    const revisions = fixture.service.getRevisions();
    const tabsRevision = fixture.service.getTabsRevision();
    await act(fixture);
    expect(changedKinds(revisions, fixture.service.getRevisions())).toEqual(kinds);
    expect(fixture.service.getTabsRevision() !== tabsRevision).toBe(tabs);
    if (kinds.length === 0) expect(fixture.service.getRevisions()).toBe(revisions);
  });

  it("combines kinds into one revision that follows only those kinds", async () => {
    const { service, scene, hero } = await openFixture();
    const classesAndTypes = () =>
      documentKindsRevision(service.getRevisions(), ["graph", "enum", "structure"]);
    const initial = classesAndTypes();

    service.updateScene(scene, { ...createDefaultScene(), name: "Edited" });
    expect(classesAndTypes()).toBe(initial);

    service.updateGraph(hero, editedGraph);
    const afterClassEdit = classesAndTypes();
    expect(afterClassEdit).not.toBe(initial);

    // A later edit of another kind draws a larger number, which must not
    // leak into this combination.
    service.updateScene(scene, { ...createDefaultScene(), name: "Edited Again" });
    expect(classesAndTypes()).toBe(afterClassEdit);
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
