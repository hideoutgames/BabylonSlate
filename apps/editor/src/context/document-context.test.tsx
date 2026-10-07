import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
  MAIN_CLASS_FILE,
  MAIN_SCENE_FILE,
  createActor,
  documentId,
  type DataDefinitionAsset,
  type DocumentRef,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import {
  DEFAULT_UNDO_BYTE_BUDGET,
  MemorySecretStore,
  OpfsStorageAdapter,
  createAppSettingsStore,
  createDerivedStorage,
} from "@babylonslate/vfs";
import { FakeLockProvider } from "@babylonslate/source-control";
import { appendJournalLines, readJournalLines } from "@babylonslate/assets";
import { SetActorTransformCommand, SetSceneNameCommand, commandToJournalPayload, serializeJournalLine } from "@babylonslate/edit";
import { UndoHistoryNotice } from "../components/undo-history-notice";
import { createProjectAsset } from "../lib/create-project-asset";
import { subscribeModelThumbnailJobs } from "../lib/model-thumbnail-queue";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { registerNavBakeSaveFlush } from "../lib/nav-bake-save";
import type { OpenDocument } from "../services/document-service";
import { ProjectService } from "../services/project-service";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  installMemoryOpfs,
  unmountDocumentProvider,
} from "../testing/real-document-provider";
import {
  DocumentProvider,
  useActiveDocumentId,
  useAppRoute,
  useDocumentActions,
  useDocumentDirty,
  useDocuments,
  useOpenDocument,
  useOpenDocumentTabs,
  useRegistryState,
  useSaveState,
  type AppRoute,
  type DocumentActions,
} from "./document-context";

// Stand-ins shared by real-provider tests: see ../testing/real-document-provider.
const provider = vi.hoisted(() => () => import("../testing/real-document-provider"));
vi.mock("../lib/engine-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-plugins")>()),
  ensureEnginePluginStorage: (await provider()).emptyEngineStorage,
}));
vi.mock("../lib/engine-plugin-library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-plugin-library")>()),
  ensureEnginePluginLibrary: (await provider()).emptyEngineLibrary,
}));
vi.mock("../lib/engine-extensions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-extensions")>()),
  ensureEngineExtensionStorage: (await provider()).emptyEngineStorage,
}));
vi.mock("../lib/engine-extension-library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-extension-library")>()),
  ensureEngineExtensionLibrary: (await provider()).emptyEngineLibrary,
}));
vi.mock("@babylonslate/render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/render")>()),
  probeKtx2TranscoderAvailable: async () => false,
  waitForSceneLoadingPaint: async () => {},
}));

type Documents = ReturnType<typeof useDocuments>;

const CLASS_KINDS = ["graph"] as const;

const seen: {
  actions: DocumentActions | null;
  documents: Documents | null;
  route: AppRoute | null;
  /** What a Class-keyed memo (palettes, prefab ancestors) is keyed on. */
  classDocuments: OpenDocument[] | null;
} = { actions: null, documents: null, route: null, classDocuments: null };

function Probe() {
  seen.actions = useDocumentActions();
  seen.documents = useDocuments();
  seen.route = useAppRoute();
  seen.classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  return null;
}

function documents(): Documents {
  if (!seen.documents) throw new Error("DocumentProvider has not rendered.");
  return seen.documents;
}

const MAIN_SCENE_ID = documentId({ kind: "scene", path: MAIN_SCENE_FILE });

function sceneRef(path: string): DocumentRef {
  return { kind: "scene", path, label: path.split("/").pop() ?? path };
}

function openScene(id: string): SerializedScene {
  const doc = documents().openDocuments.find((entry) => entry.id === id);
  if (!doc?.content) throw new Error(`${id} is not open.`);
  return doc.content as SerializedScene;
}

/** The scene with its first actor moved along X. */
function movedScene(scene: SerializedScene, dx: number): SerializedScene {
  const next = structuredClone(scene);
  const [x, y, z] = next.actors[0]!.transform.position;
  next.actors[0]!.transform.position = [x + dx, y, z];
  return next;
}

/** Mounts the real provider and creates a 2D project with its Main scene. */
async function openProject(children?: React.ReactNode): Promise<DocumentActions> {
  render(
    <DocumentProvider>
      <Probe />
      {children}
    </DocumentProvider>,
  );
  await waitFor(() => expect(documents().homepageReady).toBe(true));
  const actions = seen.actions!;
  await act(() => actions.createEmptyProject("Stable", { kind: "2d" }));
  return actions;
}

/** Creates a Scene asset in the project root, as Content Browser New Asset does. */
async function createScene(actions: DocumentActions, name: string) {
  const scene = await act(() =>
    createProjectAsset({
      registry: documents().assetRegistry!,
      rootId: "project",
      folderRelative: "",
      type: "Scene",
      name,
    }),
  );
  act(() => actions.noteAssetsCreated());
  return scene;
}

/** Saves the unsaved Main scene and opens `path`, which closes Main. */
async function saveAndSwitchScene(actions: DocumentActions, path: string) {
  await act(async () => {
    await actions.openDocument(sceneRef(path));
    await actions.confirmExclusiveSceneOpen("save");
  });
  expect(documents().openDocuments.some((doc) => doc.id === MAIN_SCENE_ID)).toBe(false);
}

function firstActorPosition(id: string) {
  return openScene(id).actors[0]!.transform.position;
}

beforeEach(installMemoryOpfs);

afterEach(async () => {
  await unmountDocumentProvider(seen.documents, seen.actions);
  seen.actions = null;
  seen.documents = null;
  seen.route = null;
  seen.classDocuments = null;
});

describe("DocumentProvider actions and route", () => {
  it("clears a recovered journal that returns to saved content without another Save", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.saveAll());
    const originalName = openScene(MAIN_SCENE_ID).name;
    const derived = await createDerivedStorage();
    const guid = documents().projectGuid!;
    await appendJournalLines(derived, guid, [
      new SetSceneNameCommand(originalName, "Temporary"),
      new SetSceneNameCommand("Temporary", originalName),
    ].map((command) => serializeJournalLine({
      v: 1, docId: MAIN_SCENE_ID, at: new Date().toISOString(), command: commandToJournalPayload(command),
    })));
    act(() => actions.keepRecovery());
    await waitFor(async () => expect(await readJournalLines(derived, guid)).toEqual([]));
    expect(openScene(MAIN_SCENE_ID).name).toBe(originalName);
    expect(documents().dirtyDocuments).toEqual([]);
  });

  it("replays a recovery request after an in-flight scene read settles", async () => {
    const actions = await openProject();
    const target = await createScene(actions, "RecoverTarget");
    const targetId = documentId({ kind: "scene", path: target.path });
    await act(() => actions.saveAll());
    await appendJournalLines(await createDerivedStorage(), documents().projectGuid!, [serializeJournalLine({
      v: 1, docId: targetId, at: new Date().toISOString(),
      command: commandToJournalPayload(new SetSceneNameCommand("RecoverTarget", "Recovered Scene")),
    })]);
    let finishRead!: () => void;
    const heldRead = new Promise<void>((resolve) => { finishRead = resolve; });
    const realLoad = ProjectService.prototype.loadDocument;
    let started = false;
    const read = vi.spyOn(ProjectService.prototype, "loadDocument").mockImplementation(async function(this: ProjectService, kind, path) {
      if (path === target.path) {
        started = true;
        await heldRead;
      }
      return realLoad.call(this, kind, path);
    });
    let opening!: Promise<unknown>;
    try {
      act(() => { opening = actions.openDocument(sceneRef(target.path)); });
      await waitFor(() => expect(started).toBe(true));
      act(() => actions.keepRecovery());
      expect(documents().openDocuments.some((doc) => doc.id === targetId)).toBe(false);
      await act(async () => { finishRead(); await opening; });
      await waitFor(() => expect(openScene(targetId).name).toBe("Recovered Scene"));
      expect(documents().dirtyDocuments.some((doc) => doc.id === targetId)).toBe(true);
    } finally {
      finishRead();
      read.mockRestore();
    }
  });

  it("keeps an open scene's unsaved edits and Class binding after renaming its Class", async () => {
    const actions = await openProject();
    const registry = documents().assetRegistry!;
    const asset = await act(() => createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Class", name: "Hero" }));
    act(() => actions.noteAssetsCreated());
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const original = openScene(MAIN_SCENE_ID);
    const edited = { ...original, actors: [...original.actors, createActor("hero", "Unsaved Hero", { classId: "Hero" })] };
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, edited));
    await act(() => actions.renameAsset(asset.header.guid, "Champion"));
    expect(openScene(MAIN_SCENE_ID).actors.find(actor => actor.id === "hero")).toMatchObject({ name: "Unsaved Hero", classId: "Champion" });
    expect(documents().dirtyDocuments.some(doc => doc.id === MAIN_SCENE_ID)).toBe(true);
    await act(() => actions.saveAll());
    const saved = await actions.loadAssetDocument("scene", MAIN_SCENE_FILE) as SerializedScene;
    expect(saved.actors.find(actor => actor.id === "hero")?.classId).toBe("Champion");
    expect(documents().assetRegistry?.getByGuid(asset.header.guid)?.path).toBe("assets/Champion.class.babasset");
  });

  it.each([false, true])("recovers unsaved Class instances after a rename and crash (rolled back: %s)", async (failRename) => {
    const actions = await openProject();
    const registry = documents().assetRegistry!;
    const asset = await act(() => createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Class", name: "Hero" }));
    act(() => actions.noteAssetsCreated());
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, {
      ...openScene(MAIN_SCENE_ID), actors: [createActor("saved", "Saved Hero", { classId: "Hero" })],
    }));
    await act(() => actions.saveAll());
    const handle = await new OpfsStorageAdapter().openDocumentsProject("Stable");
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, {
      ...openScene(MAIN_SCENE_ID), actors: [...openScene(MAIN_SCENE_ID).actors, createActor("unsaved", "Unsaved Hero", { classId: "Hero" })],
    }));
    if (failRename) {
      const write = OpfsStorageAdapter.prototype.writeBinary;
      let fail = true;
      const blocked = vi.spyOn(OpfsStorageAdapter.prototype, "writeBinary").mockImplementation(async function(this: OpfsStorageAdapter, path, bytes) {
        if (path === MAIN_SCENE_FILE && fail) { fail = false; throw new Error("Scene write failed"); }
        return write.call(this, path, bytes);
      });
      try { await act(async () => { await expect(actions.renameAsset(asset.header.guid, "Champion")).rejects.toThrow("Scene write failed"); }); }
      finally { blocked.mockRestore(); }
    } else await act(() => actions.renameAsset(asset.header.guid, "Champion"));
    // Unmount without Close/Save to preserve the crash-recovery journal.
    cleanup();
    render(<DocumentProvider><Probe /></DocumentProvider>);
    await waitFor(() => expect(documents().homepageReady).toBe(true));
    const reopened = seen.actions!;
    await act(() => reopened.openListedProject(handle));
    act(() => reopened.keepRecovery());
    await waitFor(() => expect(openScene(MAIN_SCENE_ID).actors.find(actor => actor.id === "unsaved")).toMatchObject({
      name: "Unsaved Hero", classId: failRename ? "Hero" : "Champion",
    }));
    expect(openScene(MAIN_SCENE_ID).actors.find(actor => actor.id === "saved")?.classId).toBe(failRename ? "Hero" : "Champion");
    expect(documents().dirtyDocuments.some(doc => doc.id === MAIN_SCENE_ID)).toBe(true);
  });

  it("records a SceneLayer switcher entries edit for Undo and crash recovery", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, {
      ...openScene(MAIN_SCENE_ID), actors: [createActor("switcher", "Switcher", { classId: "SceneLayerActorSwitcher" })],
    }));
    await act(() => actions.saveAll());
    const handle = await new OpfsStorageAdapter().openDocumentsProject("Stable");
    const properties = { sceneLayerActors: [{ classId: "HudLayer", defaults: { title: "Paused" } }] };
    let applied = false;
    await act(async () => {
      const saved = openScene(MAIN_SCENE_ID);
      applied = await actions.applySceneChange(MAIN_SCENE_ID, { ...saved, actors: saved.actors.map(actor => ({ ...actor, properties })) });
    });
    expect(applied).toBe(true);
    act(() => actions.undoActiveDocument());
    expect(openScene(MAIN_SCENE_ID).actors).toMatchObject([{ id: "switcher" }]);
    expect(openScene(MAIN_SCENE_ID).actors[0]!.properties).toBeUndefined();
    act(() => actions.redoActiveDocument());
    expect(openScene(MAIN_SCENE_ID).actors[0]!.properties).toEqual(properties);
    // Unmount without Close/Save to preserve the crash-recovery journal.
    cleanup();
    render(<DocumentProvider><Probe /></DocumentProvider>);
    await waitFor(() => expect(documents().homepageReady).toBe(true));
    const reopened = seen.actions!;
    await act(() => reopened.openListedProject(handle));
    act(() => reopened.keepRecovery());
    await waitFor(() => expect(openScene(MAIN_SCENE_ID).actors[0]?.properties).toEqual(properties));
  });

  it("applies an edit larger than a lowered Undo memory limit, clears Undo and notifies once per gesture", async () => {
    const actions = await openProject(<UndoHistoryNotice documentId={MAIN_SCENE_ID} />);
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 1)));
    expect(documents().canUndoActiveDocument).toBe(true);
    const settings = createAppSettingsStore();
    try {
      // The preference reaches the Main scene's existing history.
      await act(() => settings.update((current) => { current.undoByteBudget = 1_048_576; }));
      const withBlob = (blob: string): SerializedScene => {
        const scene = openScene(MAIN_SCENE_ID);
        return { ...scene, actors: scene.actors.map((actor, index) => index === 0 ? { ...actor, properties: { blob } } : actor) };
      };
      // Two steps of one gesture, each about 1.2 MB.
      await act(() => actions.applySceneChange(MAIN_SCENE_ID, withBlob("a".repeat(1_200_000))));
      await act(() => actions.applySceneChange(MAIN_SCENE_ID, withBlob("b".repeat(1_200_000))));
      expect(openScene(MAIN_SCENE_ID).actors[0]!.properties).toEqual({ blob: "b".repeat(1_200_000) });
      expect(documents().canUndoActiveDocument).toBe(false);
      expect(documents().undoHistoryNotice).toEqual({ documentId: MAIN_SCENE_ID, sequence: 1 });
      expect(screen.getByTestId("undo-history-notice").textContent).toContain("can't be undone");
      fireEvent.click(screen.getByTestId("undo-history-notice-dismiss"));
      expect(screen.queryByTestId("undo-history-notice")).toBeNull();
      expect(documents().undoHistoryNotice).toBeNull();
    } finally {
      await act(() => settings.update((current) => { current.undoByteBudget = DEFAULT_UNDO_BYTE_BUDGET; }));
    }
  });

  it("stamps Prefab overrides against a Class edited after an earlier Scene edit", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const classDocId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    await act(() => actions.openDocument({ kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }));
    const classGraph = () => documents().openDocuments.find((doc) => doc.id === classDocId)!.content as SerializedGraph;
    const sprite = (flipX: boolean): SerializedComponent => ({
      id: "component-sprite", classId: "SpriteComponent", properties: { flipX }, parentId: null,
    });
    await act(() => actions.applyGraphChange(classDocId, { ...classGraph(), components: [sprite(false)] }));
    const instance = createActor("actor-main-instance", "Main Instance", {
      classId: classIdForGraphPath(MAIN_CLASS_FILE),
      components: [{ ...sprite(false), id: "instance-sprite", sourceId: "component-sprite" }],
    });
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, { ...openScene(MAIN_SCENE_ID), actors: [instance] }));
    const editInstanceSprite = (properties: Record<string, unknown>) => {
      const scene = openScene(MAIN_SCENE_ID);
      return actions.applySceneChange(MAIN_SCENE_ID, {
        ...scene,
        actors: scene.actors.map((actor) => ({
          ...actor,
          components: actor.components.map((component) => ({
            ...component, properties: { ...component.properties, ...properties },
          })),
        })),
      });
    };
    await act(() => editInstanceSprite({ flipX: true }));
    const instanceSprite = () => openScene(MAIN_SCENE_ID).actors[0]!.components[0]!;
    expect(instanceSprite().overrideKeys).toEqual(["flipX"]);
    // The Class now matches the instance, so the next Scene edit drops that override.
    await act(() => actions.applyGraphChange(classDocId, { ...classGraph(), components: [sprite(true)] }));
    await act(() => editInstanceSprite({ flipY: true }));
    expect(instanceSprite()).toMatchObject({ properties: { flipX: true, flipY: true }, overrideKeys: ["flipY"] });
  });

  it("waits for an in-flight save before renaming a Class used by that save", async () => {
    const actions = await openProject();
    const registry = documents().assetRegistry!;
    const asset = await act(() => createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Class", name: "Hero" }));
    act(() => actions.noteAssetsCreated());
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, {
      ...openScene(MAIN_SCENE_ID), actors: [createActor("hero", "Hero", { classId: "Hero" })],
    }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const original = ProjectService.prototype.saveDocument;
    const save = vi.spyOn(ProjectService.prototype, "saveDocument").mockImplementation(async function(this: ProjectService, kind, path, content, options) {
      if (path === MAIN_SCENE_FILE && !started) { started = true; await held; }
      return original.call(this, kind, path, content, options);
    });
    try {
      let saving!: Promise<boolean>;
      act(() => { saving = actions.saveAll(); });
      await waitFor(() => expect(started).toBe(true));
      let renaming!: ReturnType<DocumentActions["renameAsset"]>;
      act(() => { renaming = actions.renameAsset(asset.header.guid, "Champion"); });
      await act(async () => { release(); await saving; await renaming; });
      const saved = await actions.loadAssetDocument("scene", MAIN_SCENE_FILE) as SerializedScene;
      expect(saved.actors.find(actor => actor.id === "hero")?.classId).toBe("Champion");
      expect(openScene(MAIN_SCENE_ID).actors.find(actor => actor.id === "hero")?.classId).toBe("Champion");
    } finally { release(); save.mockRestore(); }
  });

  it.each([false, true])("refuses Class renames when a referring scene is locked by another user (open: %s)", async (keepOpen) => {
    const actions = await openProject();
    const registry = documents().assetRegistry!;
    const asset = await act(() => createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Class", name: "Hero" }));
    act(() => actions.noteAssetsCreated());
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, {
      ...openScene(MAIN_SCENE_ID), actors: [createActor("hero", "Hero", { classId: "Hero" })],
    }));
    await act(() => actions.saveAll());
    if (!keepOpen) act(() => actions.closeDocument(MAIN_SCENE_ID));
    const storage = new OpfsStorageAdapter();
    await storage.openDocumentsProject("Stable");
    const sceneBytes = await storage.readBinary(MAIN_SCENE_FILE);
    const classBytes = await storage.readBinary(asset.path);
    const fake = new FakeLockProvider();
    fake.addTheirs(MAIN_SCENE_FILE, "Teammate");
    await act(() => documents().sourceControl.configure({
      settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, enabled: true }, projectGuid: documents().projectGuid,
      platform: "electron", testMode: true, secretStore: new MemorySecretStore(), nativeHttp: null, fake,
    }));
    await act(() => documents().sourceControl.refresh());
    await act(async () => { await expect(actions.renameAsset(asset.header.guid, "Champion")).rejects.toThrow("Locked by Teammate"); });
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(sceneBytes);
    expect(await storage.readBinary(asset.path)).toEqual(classBytes);
    expect(await storage.exists("assets/Champion.class.babasset")).toBe(false);
    expect(documents().assetRegistry!.getByGuid(asset.header.guid)?.path).toBe(asset.path);
  });

  it("finishes an admitted Save All including its bake writes before a file lock and defers later saves", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 5)));
    const authored = openScene(MAIN_SCENE_ID);
    let finishBake!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { finishBake = resolve; });
    const unregister = registerNavBakeSaveFlush(async writer => {
      entered();
      await waiting;
      if (!writer) throw new Error("Save did not provide its admitted writer.");
      await writer.writeSceneNavmeshChunk(MAIN_SCENE_FILE, new Uint8Array([7, 3, 1]), authored as unknown as Record<string, unknown>);
    });
    let lease: ReturnType<DocumentActions["lockAuthoringWrites"]> | undefined;
    try {
      let saving!: Promise<boolean>;
      act(() => { saving = actions.saveAll(); });
      await started;
      lease = actions.lockAuthoringWrites("Simulation is preparing");
      expect(await actions.saveAll()).toBe(false);
      await act(async () => { finishBake(); expect(await saving).toBe(true); });
      expect(await lease.ready).toBe(true);
      expect(documents().dirtyDocuments).toEqual([]);
      const stored = await actions.loadAssetDocument("scene", MAIN_SCENE_FILE) as SerializedScene;
      expect(stored.actors[0]!.transform.position).toEqual(authored.actors[0]!.transform.position);
      expect(await actions.readAssetChunk(MAIN_SCENE_FILE, "navmesh")).toEqual(new Uint8Array([7, 3, 1]));
    } finally {
      finishBake?.();
      unregister();
      lease?.release();
    }
  });

  it("preserves authored content and existing Redo when authoring rejects edits and history actions", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const baseline = openScene(MAIN_SCENE_ID);
    const edited = movedScene(baseline, 2);
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, edited));
    act(() => actions.undoActiveDocument());
    expect(documents().canRedoActiveDocument).toBe(true);
    const restored = openScene(MAIN_SCENE_ID);
    const revisions = documents().documentRevisions;
    const settings = documents().projectDocument!.settings;
    let release!: () => void;
    act(() => { release = actions.lockAuthoring("Read-only during a session."); });
    expect(() => actions.closeDocument(MAIN_SCENE_ID)).toThrow("Read-only during a session.");
    expect(() => actions.closeDocumentsForPaths([MAIN_SCENE_FILE])).toThrow("Read-only during a session.");
    expect(() => actions.repathDocument("scene", MAIN_SCENE_FILE, "assets/Renamed.babasset")).toThrow("Read-only during a session.");
    expect(documents().canUndoActiveDocument).toBe(false);
    expect(documents().canRedoActiveDocument).toBe(false);
    await act(async () => {
      expect(await actions.applySceneChange(MAIN_SCENE_ID, movedScene(restored, 20))).toBe(false);
      actions.updateScene(MAIN_SCENE_ID, movedScene(restored, 30));
      actions.undoActiveDocument();
      actions.redoActiveDocument();
      actions.updateProjectSettings({ compileOnSave: !settings.compileOnSave });
      await actions.confirmExternalChangeReloadDocs([MAIN_SCENE_FILE]);
    });
    expect(openScene(MAIN_SCENE_ID)).toBe(restored);
    expect(documents().documentRevisions).toBe(revisions);
    expect(documents().projectDocument!.settings).toBe(settings);
    act(release);
    expect(documents().canRedoActiveDocument).toBe(true);
    act(() => actions.redoActiveDocument());
    expect(firstActorPosition(MAIN_SCENE_ID)).toEqual(edited.actors[0]!.transform.position);
    act(() => actions.undoActiveDocument());
    expect(firstActorPosition(MAIN_SCENE_ID)).toEqual(baseline.actors[0]!.transform.position);
  });

  it("ignores an external reload that crosses an authoring lease even when it finishes after release", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const stored = openScene(MAIN_SCENE_ID);
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(stored, 4)));
    const authored = openScene(MAIN_SCENE_ID);
    let finishRead!: (content: Awaited<ReturnType<ProjectService["loadDocument"]>>) => void;
    const original = ProjectService.prototype.loadDocument;
    const read = vi.spyOn(ProjectService.prototype, "loadDocument").mockImplementation(function (this: ProjectService, kind, path) {
      if (kind === "scene" && path === MAIN_SCENE_FILE) {
        return new Promise<Awaited<ReturnType<ProjectService["loadDocument"]>>>(resolve => { finishRead = resolve; });
      }
      return original.call(this, kind, path);
    });
    try {
      let pending!: Promise<void>;
      act(() => { pending = actions.confirmExternalChangeReloadDocs([MAIN_SCENE_FILE]); });
      await waitFor(() => expect(finishRead).toBeTypeOf("function"));
      act(() => {
        const release = actions.lockAuthoring("Read-only during a session.");
        release();
      });
      await act(async () => { finishRead(stored); await pending; });
      expect(openScene(MAIN_SCENE_ID)).toBe(authored);
      expect(documents().canUndoActiveDocument).toBe(true);
      act(() => actions.undoActiveDocument());
      expect(firstActorPosition(MAIN_SCENE_ID)).toEqual(stored.actors[0]!.transform.position);
    } finally {
      read.mockRestore();
    }
  });

  it("awaits a session transition owner before closing a scene and preserves the project when Stop is refused", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const original = openScene(MAIN_SCENE_ID);
    let resolve!: (allowed: boolean) => void;
    const unregister = actions.registerBeforeTransition(() => new Promise<boolean>(done => { resolve = done; }));
    act(() => actions.closeDocument(MAIN_SCENE_ID));
    expect(openScene(MAIN_SCENE_ID)).toBe(original);
    await act(async () => { resolve(false); await Promise.resolve(); });
    expect(openScene(MAIN_SCENE_ID)).toBe(original);
    let closing!: Promise<void>;
    act(() => { closing = actions.forceCloseProject(); });
    await act(async () => { resolve(false); await closing; });
    expect(documents().route).toBe("editor");
    expect(openScene(MAIN_SCENE_ID)).toBe(original);
    act(() => actions.closeDocument(MAIN_SCENE_ID));
    await act(async () => { resolve(true); await Promise.resolve(); });
    expect(documents().openDocuments.some(doc => doc.id === MAIN_SCENE_ID)).toBe(false);
    unregister();
  });

  it("loads a restored cold document before replaying its recovery journal", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const original = openScene(MAIN_SCENE_ID);
    const recovered = movedScene(original, 7);
    await act(() => actions.saveAll());
    const guid = documents().projectGuid!;
    const listed = documents().listedProjects.find(project => project.label === "Stable")!;
    await act(() => actions.forceCloseProject());

    // Simulate an edit persisted by crash recovery, after the last saved layout.
    const derived = await createDerivedStorage();
    await appendJournalLines(derived, guid, [JSON.stringify({
      v: 1, docId: MAIN_SCENE_ID, at: new Date().toISOString(),
      command: commandToJournalPayload(new SetActorTransformCommand(
        original.actors[0]!.id, original.actors[0]!.transform, recovered.actors[0]!.transform,
      )),
    })]);
    await act(() => actions.openListedProject(listed));
    expect(documents().openDocuments.find(doc => doc.id === MAIN_SCENE_ID)?.content).toBeNull();
    expect(documents().recoveryAvailable).toBe(true);
    act(() => actions.keepRecovery());
    await waitFor(() => expect(openScene(MAIN_SCENE_ID).actors[0]!.transform.position).toEqual(recovered.actors[0]!.transform.position));
    expect(documents().dirtyDocuments.map(doc => doc.id)).toContain(MAIN_SCENE_ID);
    expect(documents().recoveryAvailable).toBe(false);
  });

  it("compiles the launch snapshot after an open Class is edited again", async () => {
    const actions = await openProject();
    const ref = { kind: "graph" as const, path: MAIN_CLASS_FILE, label: "Main" };
    await act(() => actions.openDocument(ref));
    const id = documentId(ref);
    const graph = actions.getOpenDocuments().find(document => document.id === id)!.content as SerializedGraph;
    const withSpeed = (speed: number): SerializedGraph => ({ ...graph, members: [
      ...(graph.members ?? []), { id: "speed", kind: "variable", name: "Speed", typeId: "float", defaultValue: speed },
    ] });
    await act(() => actions.applyGraphChange(id, withSpeed(7)));
    const snapshot = actions.getOpenDocuments().map(document => ({ ...document }));
    await act(() => actions.applyGraphChange(id, withSpeed(19)));
    const guid = documents().assetRegistry!.list().find(asset => asset.path === MAIN_CLASS_FILE)!.header.guid;
    const required = new Set([guid]);
    const captured = await actions.collectPlayPreviewScripts(required, snapshot);
    const current = await actions.collectPlayPreviewScripts(required);
    expect(captured.bundles.find(bundle => bundle.classId === classIdForGraphPath(MAIN_CLASS_FILE))?.variables)
      .toContainEqual({ name: "Speed", type: "float", defaultValue: 7 });
    expect(current.bundles.find(bundle => bundle.classId === classIdForGraphPath(MAIN_CLASS_FILE))?.variables)
      .toContainEqual({ name: "Speed", type: "float", defaultValue: 19 });
    expect(actions.getOpenDocuments().find(document => document.id === id)?.dirty).toBe(true);
  });

  it("keeps unrequested scene, script, and resource payloads unread during selected Play collection", async () => {
    const actions = await openProject();
    const registry = documents().assetRegistry!;
    await createScene(actions, "Deferred");
    await act(() => createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Class", name: "DeferredClass" }));
    for (const type of ["Water", "RenderTarget", "InputAction", "Audio", "ParticleEmitter", "Font", "DataDefinition", "Model"]) {
      await registry.createAsset("project", `Deferred-${type}.babasset`, {
        guid: `deferred-${type}`, type, name: `Deferred ${type}`, version: 1,
        dependencies: [], payload: {},
        chunks: [{ id: "source", kind: "source", mime: "application/octet-stream", data: new Uint8Array(128 * 1024) }],
      });
    }
    const storage = registry.storageFor("project");
    const before = storage.getReadMetrics!().actualBytesRead;
    const required = new Set<string>();
    expect(await actions.collectPlaySceneLibrary(required)).toEqual([]);
    expect(await actions.collectPlayPreviewScripts(required)).toEqual({ bundles: [], diagnostics: [] });
    expect(await actions.collectEditorUtilityScripts()).toEqual([]);
    expect(await actions.collectPlayDataAssets(required)).toEqual([]);
    expect(await actions.collectPlayInputAssets(required)).toEqual([]);
    expect(await actions.collectPlayFontFaceEntries(required)).toEqual([]);
    expect((await actions.collectPlayWaterContent(required)).size).toBe(0);
    const targets = await actions.collectPlayRenderTargets(required);
    expect(targets.renderTargets.size).toBe(0);
    expect(targets.renderTargetTextures.size).toBe(0);
    await actions.collectPlayAudio(required);
    await actions.collectPlayParticles(required);
    const thumbnails = vi.fn();
    const unsubscribe = subscribeModelThumbnailJobs(thumbnails);
    try {
      expect(await actions.loadAssetThumbnail("deferred-Model")).toBeNull();
      expect(thumbnails).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
    expect(storage.getReadMetrics!().actualBytesRead).toBe(before);
  });

  it.each(["delete", "replace"] as const)("repairs nested data defaults in open documents during Class %s using live and saved schemas", async (operation) => {
    const actions = await openProject();
    const registry = documents().assetRegistry!;
    const create = (type: "Class" | "DataDefinition", name: string, dataDefinition?: DataDefinitionAsset, typeSchemas?: Parameters<typeof createProjectAsset>[0]["typeSchemas"]) =>
      act(() => createProjectAsset({ registry, rootId: "project", folderRelative: "", type, name, dataDefinition, typeSchemas }));
    const target = await create("Class", "Disposable");
    const replacement = operation === "replace" ? await create("Class", "Replacement") : null;
    const typedFields = [
      { id: "target", name: "Target", typeId: "asset", typeClassId: "Class", defaultValue: "" },
      { id: "note", name: "Note", typeId: "string", defaultValue: "" },
    ];
    const storedFields = typedFields.map(field => ({ ...field, typeId: "string", typeClassId: undefined }));
    const saved = await create("DataDefinition", "Saved", { kind: "dataDefinition", fields: typedFields });
    const live = await create("DataDefinition", "Live", { kind: "dataDefinition", fields: storedFields });
    const payload: DataDefinitionAsset = { kind: "dataDefinition", fields: [
      { id: "saved", name: "Saved", typeId: "struct", typeClassId: saved.header.guid, defaultValue: { Target: target.header.guid, Note: target.header.guid } },
      { id: "live", name: "Live", typeId: "struct", typeClassId: live.header.guid, defaultValue: { Target: target.header.guid, Note: target.header.guid } },
    ] };
    const parent = await create("DataDefinition", "Parent", payload, {
      structs: {}, enums: {}, dataDefinitions: {
        [saved.header.guid]: { name: "Saved", fields: typedFields },
        [live.header.guid]: { name: "Live", fields: storedFields },
      },
    });
    act(() => actions.noteAssetsCreated());
    await act(() => actions.openDocument({ kind: "data-definition", path: live.path, label: "Live" }));
    await act(() => actions.applyAssetDocumentChange(documentId({ kind: "data-definition", path: live.path }), { kind: "dataDefinition", fields: typedFields }));
    await act(() => actions.openDocument({ kind: "data-definition", path: parent.path, label: "Parent" }));
    const parentId = documentId({ kind: "data-definition", path: parent.path });
    await act(() => actions.applyAssetDocumentChange(parentId, { ...payload, fields: payload.fields.map(field => ({ ...field, category: "Unsaved Edit" })) }));
    // The open schema's type change has not reached the registry header.
    expect(registry.getByGuid(live.header.guid)!.header.payload.fields).toMatchObject([{ typeId: "string" }, {}]);
    await act(async () => {
      const deleting = new Set([target.header.guid]);
      if (replacement) await actions.replaceClassReferencesBeforeDelete([{
        guid: target.header.guid, classId: "Disposable", replacement: { guid: replacement.header.guid, classId: "Replacement" },
      }], deleting);
      await registry.deleteAsset(target.header.guid);
      await actions.repairAfterAssetDelete(deleting, new Set(["Disposable"]));
    });
    const expected = payload.fields.map(field => ({
      ...field, category: "Unsaved Edit", defaultValue: { Target: replacement?.header.guid ?? "", Note: target.header.guid },
    }));
    expect(documents().openDocuments.find(doc => doc.id === parentId)?.content).toEqual({ kind: "dataDefinition", fields: expected });
    expect(documents().dirtyDocuments.some(doc => doc.id === parentId)).toBe(true);
    await act(() => actions.saveAll());
    act(() => actions.closeDocument(parentId));
    expect(await actions.loadAssetDocument("data-definition", parent.path)).toEqual({ kind: "dataDefinition", fields: expected });
  });

  it("keeps one actions object across edits, Anim modes and settings while acting on the latest state", async () => {
    const actions = await openProject();
    const callbacks = { ...actions };

    // A document edit.
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const before = openScene(MAIN_SCENE_ID);
    const edited = movedScene(before, 1.5);
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, edited));
    expect(openScene(MAIN_SCENE_ID).actors[0]!.transform.position).toEqual(
      edited.actors[0]!.transform.position,
    );

    // An Animation Graph mode change.
    const animation = await act(() =>
      createProjectAsset({
        registry: documents().assetRegistry!,
        rootId: "project",
        folderRelative: "",
        type: "AnimationGraph",
        name: "Locomotion",
      }),
    );
    act(() => actions.noteAssetsCreated());
    await act(() =>
      actions.openDocument({
        kind: "anim-graph",
        path: animation.path,
        label: "Locomotion",
      }),
    );
    const animationId = documentId({ kind: "anim-graph", path: animation.path });
    act(() => actions.setAnimEditorMode(animationId, "animationObject"));
    expect(documents().activeDocumentId).toBe(animationId);
    expect(documents().animEditorMode).toBe("animationObject");

    // A Project Settings edit.
    act(() => actions.updateProjectSettings({ compileOnSave: false }));
    expect(documents().projectDocument?.settings.compileOnSave).toBe(false);

    expect(seen.actions).toBe(actions);
    const facade = documents();
    for (const [name, callback] of Object.entries(callbacks)) {
      expect(seen.actions![name as keyof DocumentActions], name).toBe(callback);
      expect(facade[name as keyof DocumentActions], name).toBe(callback);
    }

    // Save All, taken before any of the changes, writes all of them.
    await act(() => callbacks.saveAll());
    expect(documents().dirtyDocuments).toEqual([]);
    expect(documents().projectDirty).toBe(false);

    const listed = documents().listedProjects.find(
      (project) => project.label === "Stable",
    );
    await act(() => callbacks.forceCloseProject());
    await act(() => callbacks.openListedProject(listed!));
    expect(documents().projectDocument?.settings.compileOnSave).toBe(false);
    const saved = (await callbacks.loadAssetDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    expect(saved.actors[0]!.transform.position).toEqual(
      edited.actors[0]!.transform.position,
    );
  });

  it("opens an exclusive scene confirmed in the same event that requested it", async () => {
    const actions = await openProject();
    const second = await createScene(actions, "Second");
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() =>
      actions.applySceneChange(
        MAIN_SCENE_ID,
        movedScene(openScene(MAIN_SCENE_ID), 2),
      ),
    );
    const secondId = documentId({ kind: "scene", path: second.path });

    // The unsaved Main scene blocks the open until the request is confirmed.
    await act(async () => {
      await actions.openDocument(sceneRef(second.path));
      await actions.confirmExclusiveSceneOpen("discard");
    });

    expect(documents().pendingExclusiveScene).toBeNull();
    expect(documents().activeDocumentId).toBe(secondId);
    expect(
      documents()
        .openDocuments.filter((doc) => doc.ref.kind === "scene")
        .map((doc) => doc.id),
    ).toEqual([secondId]);

    // The discarded edit's history cannot reapply to the saved Main.
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    expect(documents().canUndoActiveDocument).toBe(false);
  });

  it("keeps document lists through registry-only updates and tab switches, and Class inputs through Scene edits", async () => {
    const actions = await openProject();
    const classId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() =>
      actions.openDocument({ kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }),
    );
    const before = documents();
    const classDocuments = seen.classDocuments;
    expect(classDocuments?.map((doc) => doc.id)).toEqual([classId]);

    // Show Plugin Content is registry-only, like encode progress or plugins.
    act(() => actions.setShowPluginContent(!before.showPluginContent));
    expect(documents().registryEpoch).not.toBe(before.registryEpoch);
    expect(documents().openDocuments).toBe(before.openDocuments);
    expect(documents().tabOrder).toBe(before.tabOrder);
    expect(documents().dirtyDocuments).toBe(before.dirtyDocuments);
    expect(seen.classDocuments).toBe(classDocuments);

    // Switching tabs moves no tab and edits no document.
    act(() => actions.setActiveDocument(MAIN_SCENE_ID));
    expect(documents().activeDocumentId).toBe(MAIN_SCENE_ID);
    expect(documents().openDocuments).toBe(before.openDocuments);
    expect(documents().tabOrder).toBe(before.tabOrder);

    // A Scene edit reaches the scene's readers but no Class-keyed input.
    const edited = movedScene(openScene(MAIN_SCENE_ID), 3);
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, edited));
    expect(openScene(MAIN_SCENE_ID).actors[0]!.transform.position).toEqual(
      edited.actors[0]!.transform.position,
    );
    expect(documents().dirtyDocuments.map((doc) => doc.id)).toEqual([MAIN_SCENE_ID]);
    expect(documents().documentRevisions.scene).not.toBe(before.documentRevisions.scene);
    expect(documents().documentRevisions.graph).toBe(before.documentRevisions.graph);
    expect(seen.classDocuments).toBe(classDocuments);
  });

  it("reports the route through useAppRoute as projects open and close", async () => {
    render(
      <DocumentProvider>
        <Probe />
      </DocumentProvider>,
    );
    await waitFor(() => expect(documents().homepageReady).toBe(true));
    expect(seen.route).toBe("home");
    const actions = seen.actions!;

    await act(() => actions.createEmptyProject("Routes", { kind: "2d" }));
    expect(seen.route).toBe("editor");

    await act(() => actions.forceCloseProject());
    expect(seen.route).toBe("home");
  });
});

describe("DocumentProvider closed document history", () => {
  it("restores Main's pre-edit value with Undo after the exclusive switch closed it and it reopened", async () => {
    const actions = await openProject();
    const second = await createScene(actions, "Second");
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const before = structuredClone(firstActorPosition(MAIN_SCENE_ID));
    await act(() =>
      actions.applySceneChange(
        MAIN_SCENE_ID,
        movedScene(openScene(MAIN_SCENE_ID), 2),
      ),
    );
    await saveAndSwitchScene(actions, second.path);

    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    expect(documents().canUndoActiveDocument).toBe(true);
    await act(async () => actions.undoActiveDocument());

    expect(firstActorPosition(MAIN_SCENE_ID)).toEqual(before);
  });

  it("reopens Main with empty history when its file changed while it was closed", async () => {
    const actions = await openProject();
    const second = await createScene(actions, "Second");
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() =>
      actions.applySceneChange(
        MAIN_SCENE_ID,
        movedScene(openScene(MAIN_SCENE_ID), 2),
      ),
    );
    await saveAndSwitchScene(actions, second.path);

    // Another writer (a sync tool, another editor window) saves Main.
    const storage = new OpfsStorageAdapter();
    await storage.openDocumentsProject("Stable");
    const external = new ProjectService(storage);
    await external.loadCurrentProject();
    const saved = (await external.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    const changed = movedScene(saved, 5);
    await external.saveDocument("scene", MAIN_SCENE_FILE, changed);
    await external.closeProject();

    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    expect(firstActorPosition(MAIN_SCENE_ID)).toEqual(
      changed.actors[0]!.transform.position,
    );
    expect(documents().canUndoActiveDocument).toBe(false);
  });

  it("reopens Main with empty history when the open-time prefab sync updates its Class instance", async () => {
    const actions = await openProject();
    const second = await createScene(actions, "Second");
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const instance = createActor("actor-main-instance", "Main Instance", {
      classId: classIdForGraphPath(MAIN_CLASS_FILE),
    });
    const scene = openScene(MAIN_SCENE_ID);
    await act(() =>
      actions.applySceneChange(MAIN_SCENE_ID, {
        ...scene,
        actors: [...scene.actors, instance],
      }),
    );
    await saveAndSwitchScene(actions, second.path);
    // While the Class is unchanged, the history resumes on reopen and stays
    // kept through the next switch.
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    expect(documents().canUndoActiveDocument).toBe(true);
    await act(() => actions.openDocument(sceneRef(second.path)));

    // With Main closed, the Main Class gains a prefab component.
    const classDocId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    await act(() =>
      actions.openDocument({ kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }),
    );
    const graph = documents().openDocuments.find((doc) => doc.id === classDocId)!
      .content as SerializedGraph;
    const sprite: SerializedComponent = {
      id: "component-sprite",
      classId: "SpriteComponent",
      properties: {},
      parentId: null,
    };
    await act(() =>
      actions.applyGraphChange(classDocId, {
        ...graph,
        components: [...(graph.components ?? []), sprite],
      }),
    );

    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    const synced = openScene(MAIN_SCENE_ID).actors.find(
      (actor) => actor.id === instance.id,
    )!;
    expect(synced.components.map((component) => component.sourceId)).toEqual([
      sprite.id,
    ]);
    // History from before the sync cannot replay onto the synced instance.
    expect(documents().canUndoActiveDocument).toBe(false);
    expect(documents().canRedoActiveDocument).toBe(false);
  });

  it("gives a Scene created at a deleted Scene's path none of the deleted Scene's history", async () => {
    const actions = await openProject();
    const second = await createScene(actions, "Second");
    const secondId = documentId({ kind: "scene", path: second.path });
    await act(() => actions.openDocument(sceneRef(second.path)));
    const original = structuredClone(openScene(secondId));
    // Edit and Undo, then save: the history waits in Redo on unchanged content.
    await act(() => actions.applySceneChange(secondId, movedScene(original, 2)));
    await act(async () => actions.undoActiveDocument());
    await act(() => actions.saveAll());
    expect(documents().canRedoActiveDocument).toBe(true);
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));

    // Content Browser Delete.
    const registry = documents().assetRegistry!;
    await act(async () => {
      actions.closeDocumentsForPaths([second.path]);
      await registry.deleteAsset(second.header.guid);
      await actions.repairAfterAssetDelete(new Set([second.header.guid]));
    });
    const recreated = await createScene(actions, "Second");
    expect(recreated.path).toBe(second.path);
    await act(() => actions.openDocument(sceneRef(second.path)));

    // Same path and the same content the old history was built on.
    expect(openScene(secondId)).toEqual(original);
    expect(documents().canUndoActiveDocument).toBe(false);
    expect(documents().canRedoActiveDocument).toBe(false);
  });

  it("reports failed automatic saves and saves retained edits on the next attempt", async () => {
    const actions = await openProject();
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.saveAll());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const save = vi.spyOn(ProjectService.prototype, "saveProject").mockRejectedValueOnce(new Error("Storage unavailable"));
    // Fire the debounce, then let the save's own timers and storage I/O run
    // until it settles; a real macrotask per step lets slow I/O finish.
    const runAutoSave = async () => {
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      for (let i = 0; i < 1_000 && documents().autoSaveStatus?.state === "saving"; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
          await new Promise((resolve) => setImmediate(resolve));
        });
      }
    };
    try {
      await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 2)));
      await runAutoSave();
      expect(documents().autoSaveStatus).toMatchObject({ state: "error", message: expect.stringContaining("Storage unavailable") });
      expect(documents().dirtyDocuments.length > 0 || documents().projectDirty).toBe(true);
      await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 2)));
      await runAutoSave();
      expect(documents().autoSaveStatus).toEqual({ state: "saved" });
      expect(documents().dirtyDocuments).toHaveLength(0);
      expect(documents().projectDirty).toBe(false);
    } finally {
      save.mockRestore();
      vi.useRealTimers();
    }
  });

});

describe("DocumentProvider narrow subscriptions", () => {
  /** Counts each render of a subscriber and keeps the value it rendered with. */
  function counter<T>(useValue: () => T) {
    const probe = { renders: 0, value: undefined as T | undefined };
    function Subscriber() {
      probe.value = useValue();
      probe.renders += 1;
      return null;
    }
    return { probe, Subscriber };
  }

  it("re-renders a document's subscribers for that document only, and action-only consumers never", async () => {
    const classId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    const sceneContent = counter(() => useOpenDocument(MAIN_SCENE_ID)?.content);
    const sceneDirty = counter(() => useDocumentDirty(MAIN_SCENE_ID));
    const classContent = counter(() => useOpenDocument(classId)?.content);
    const classDirty = counter(() => useDocumentDirty(classId));
    const active = counter(() => useActiveDocumentId());
    const actionsOnly = counter(() => useDocumentActions());
    const registry = counter(() => useRegistryState());
    const actions = await openProject(
      <>
        <sceneContent.Subscriber />
        <sceneDirty.Subscriber />
        <classContent.Subscriber />
        <classDirty.Subscriber />
        <active.Subscriber />
        <actionsOnly.Subscriber />
        <registry.Subscriber />
      </>,
    );
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.openDocument({ kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }));
    const renders = () => ({
      sceneContent: sceneContent.probe.renders,
      sceneDirty: sceneDirty.probe.renders,
      classContent: classContent.probe.renders,
      classDirty: classDirty.probe.renders,
      active: active.probe.renders,
      actionsOnly: actionsOnly.probe.renders,
      registry: registry.probe.renders,
    });
    const opened = renders();
    const registryState = registry.probe.value;

    // The first edit of Main dirties it; the second keeps it dirty.
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 1)));
    expect(sceneContent.probe.value).toBe(openScene(MAIN_SCENE_ID));
    expect(sceneDirty.probe.value).toBe(true);
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 1)));
    expect(sceneContent.probe.value).toBe(openScene(MAIN_SCENE_ID));
    expect(renders()).toEqual({
      ...opened,
      sceneContent: opened.sceneContent + 2,
      sceneDirty: opened.sceneDirty + 1,
    });
    expect(registry.probe.value).toBe(registryState);

    // A tab switch reaches the active tab's readers only.
    const edited = renders();
    act(() => actions.setActiveDocument(MAIN_SCENE_ID));
    expect(active.probe.value).toBe(MAIN_SCENE_ID);
    expect(renders()).toEqual({ ...edited, active: edited.active + 1 });
  });

  it("keeps tab and dirty lists through further edits of a dirty document", async () => {
    const tabs = counter(() => useOpenDocumentTabs());
    const save = counter(() => useSaveState());
    const actions = await openProject(
      <>
        <tabs.Subscriber />
        <save.Subscriber />
      </>,
    );
    await act(() => actions.openDocument(sceneRef(MAIN_SCENE_FILE)));
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 1)));
    expect(tabs.probe.value?.find((doc) => doc.id === MAIN_SCENE_ID)?.dirty).toBe(true);
    expect(save.probe.value?.dirtyDocuments.map((doc) => doc.id)).toEqual([MAIN_SCENE_ID]);
    const dirtyTabs = tabs.probe.value;
    const dirtySave = save.probe.value;
    const rendered = { tabs: tabs.probe.renders, save: save.probe.renders };

    // Each edit replaces the Scene's ref with an equal copy: nothing a tab shows changes.
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 1)));
    await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 1)));
    expect(tabs.probe.value).toBe(dirtyTabs);
    expect(save.probe.value).toBe(dirtySave);
    expect({ tabs: tabs.probe.renders, save: save.probe.renders }).toEqual(rendered);

    // Saving clears the dirty flag, and both lists show it.
    await act(() => actions.saveAll());
    expect(tabs.probe.value?.find((doc) => doc.id === MAIN_SCENE_ID)?.dirty).toBe(false);
    expect(save.probe.value?.dirtyDocuments).toEqual([]);
  });
});
