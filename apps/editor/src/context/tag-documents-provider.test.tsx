import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTags, type TagApi } from "@babylonslate/editor-kit";
import {
  installMemoryOpfs,
  unmountDocumentProvider,
} from "../testing/real-document-provider";
import {
  DocumentProvider,
  useDocumentActions,
  useDocuments,
  type DocumentActions,
} from "./document-context";
import { TagDocumentsProvider } from "./tag-documents-provider";

// Keep real document writes and reloads; replace only bundled resources and
// GPU-specific readiness probes, as in the document provider integration tests.
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
const seen: {
  actions: DocumentActions | null;
  documents: Documents | null;
  tags: TagApi | null;
} = { actions: null, documents: null, tags: null };

function Probe() {
  seen.actions = useDocumentActions();
  seen.documents = useDocuments();
  seen.tags = useTags();
  return null;
}

async function openProject(name: string): Promise<DocumentActions> {
  render(
    <DocumentProvider>
      <TagDocumentsProvider>
        <Probe />
      </TagDocumentsProvider>
    </DocumentProvider>,
  );
  await waitFor(() => expect(seen.documents?.homepageReady).toBe(true));
  await act(() => seen.actions!.createEmptyProject(name, { kind: "2d" }));
  act(() => seen.actions!.updateProjectSettings({ compileOnSave: false }));
  return seen.actions!;
}

beforeEach(installMemoryOpfs);

afterEach(async () => {
  await unmountDocumentProvider(seen.documents, seen.actions);
  seen.actions = null;
  seen.documents = null;
  seen.tags = null;
});

describe("TagDocumentsProvider persistence", () => {
  it("saves consecutive creates from one event and resumes allocation after reopening", async () => {
    const actions = await openProject("Tag Persistence");
    const create = seen.tags!.onCreate!;
    act(() => {
      expect(create("Ability.Damage.Fire")).toBe(3);
      expect(create("Ability.Damage.Ice")).toBe(4);
      // Another settings edit in the same event must retain both creations.
      actions.updateProjectSettings({ playFrameCap: 30 });
    });
    expect(seen.tags!.entries).toEqual([
      { id: 1, path: "Ability", parentId: 0 },
      { id: 2, path: "Ability.Damage", parentId: 1 },
      { id: 3, path: "Ability.Damage.Fire", parentId: 2 },
      { id: 4, path: "Ability.Damage.Ice", parentId: 2 },
    ]);
    expect(seen.documents!.projectDirty).toBe(true);
    await act(async () => { expect(await actions.saveAll()).toBe(true); });
    const saved = seen.documents!.listedProjects.find((entry) => entry.label === "Tag Persistence");
    expect(saved).toBeDefined();

    await act(() => actions.forceCloseProject());
    expect(seen.tags!.entries).toEqual([]);
    expect(seen.tags!.onCreate).toBeUndefined();
    await act(() => actions.openListedProject(saved!));
    expect(seen.documents!.projectDocument?.settings.playFrameCap).toBe(30);
    expect(seen.tags!.entries.map((entry) => entry.path)).toEqual([
      "Ability", "Ability.Damage", "Ability.Damage.Fire", "Ability.Damage.Ice",
    ]);
    act(() => {
      expect(seen.tags!.onCreate!("Ability.Damage.Fire")).toBe(3);
      expect(seen.tags!.onCreate!("Ability.Damage.Lightning")).toBe(5);
    });
  });

  it("isolates project registries when closing, creating another project, and returning", async () => {
    const actions = await openProject("First Tags");
    act(() => { expect(seen.tags!.onCreate!("First.Ready")).toBe(2); });
    await act(async () => { expect(await actions.saveAll()).toBe(true); });
    const firstCreate = seen.tags!.onCreate!;
    const first = seen.documents!.listedProjects.find((entry) => entry.label === "First Tags");
    expect(first).toBeDefined();
    await act(() => actions.forceCloseProject());
    await act(() => actions.createEmptyProject("Second Tags", { kind: "2d" }));
    expect(seen.tags!.entries).toEqual([]);
    expect(() => firstCreate("First.Stale")).toThrow("active project changed");
    act(() => {
      actions.updateProjectSettings({ compileOnSave: false });
      expect(seen.tags!.onCreate!("Second.Ready")).toBe(2);
    });
    expect(seen.tags!.entries.map((entry) => entry.path)).toEqual(["Second", "Second.Ready"]);
    await act(async () => { expect(await actions.saveAll()).toBe(true); });
    await act(() => actions.forceCloseProject());
    await act(() => actions.openListedProject(first!));
    expect(seen.tags!.entries).toEqual([
      { id: 1, path: "First", parentId: 0 },
      { id: 2, path: "First.Ready", parentId: 1 },
    ]);
    act(() => { expect(seen.tags!.onCreate!("First.Running")).toBe(3); });
  });
});
