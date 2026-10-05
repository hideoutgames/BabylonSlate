import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CLASS_FILE,
  MAIN_SCENE_FILE,
  documentId,
  type DocumentRef,
  type SerializedScene,
} from "@babylonslate/core";
import { createProjectAsset } from "../lib/create-project-asset";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import type { OpenDocument } from "../services/document-service";
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

beforeEach(installMemoryOpfs);

afterEach(async () => {
  await unmountDocumentProvider(seen.documents, seen.actions);
  seen.actions = null;
  seen.documents = null;
  seen.route = null;
  seen.classDocuments = null;
});

describe("DocumentProvider actions and route", () => {
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
    const second = await act(() =>
      createProjectAsset({
        registry: documents().assetRegistry!,
        rootId: "project",
        folderRelative: "",
        type: "Scene",
        name: "Second",
      }),
    );
    act(() => actions.noteAssetsCreated());
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
