import { act, cleanup, render, waitFor } from "@testing-library/react";
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
import { MemorySecretStore, OpfsStorageAdapter, createDerivedStorage } from "@babylonslate/vfs";
import { FakeLockProvider } from "@babylonslate/source-control";
import { appendJournalLines, readJournalLines } from "@babylonslate/assets";
import { SetSceneNameCommand, commandToJournalPayload, serializeJournalLine } from "@babylonslate/edit";
import { createProjectAsset } from "../lib/create-project-asset";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import type { OpenDocument } from "../services/document-service";
import { ProjectService } from "../services/project-service";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  installMemoryOpfs,
  unmountDocumentProvider,
} from "../testing/real-document-provider";
import {
  DocumentProvider,
  useAppRoute,
  useDocumentActions,
  useDocuments,
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
async function openProject(): Promise<DocumentActions> {
  render(
    <DocumentProvider>
      <Probe />
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
    try {
      await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 2)));
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(documents().autoSaveStatus).toMatchObject({ state: "error", message: expect.stringContaining("Storage unavailable") });
      expect(documents().dirtyDocuments.length > 0 || documents().projectDirty).toBe(true);
      await act(() => actions.applySceneChange(MAIN_SCENE_ID, movedScene(openScene(MAIN_SCENE_ID), 2)));
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(documents().autoSaveStatus).toEqual({ state: "saved" });
      expect(documents().dirtyDocuments).toHaveLength(0);
      expect(documents().projectDirty).toBe(false);
    } finally {
      save.mockRestore();
      vi.useRealTimers();
    }
  });

});
