import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { projectContentRoot, type IndexedAsset } from "@haptic/assets";
import { SOURCE_CONTROL_ID } from "@haptic/core";
import { FakeLockProvider } from "@haptic/source-control";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
import { SourceControlActionsProvider } from "./source-control-actions";
import { KeybindProvider } from "../context/keybind-context";
import { SourceControlService } from "../services/source-control-service";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { integratedSync } from "../testing/integrated-sync";
import { MANUAL_SOURCE_CONTROL, signedInHosts } from "../testing/source-control-hosts";

const FOREST = "assets/Forest.scene.hasset";
const ROCK = "assets/Rock.texture.hasset";
const CAVE = "assets/Cave.scene.hasset";

const fixture = vi.hoisted(() => ({
  locks: null as SourceControlService | null,
  sync: null as SourceControlSyncService | null,
  setActiveDocument: vi.fn(),
  docs: {} as Record<string, unknown>,
}));

/** The documents value, renewed whenever the lock service changes, as `useSourceControl` is in the editor. */
function useLiveDocs() {
  const [tick, setTick] = useState(0);
  useEffect(() => fixture.locks?.subscribe(() => setTick((value) => value + 1)), []);
  return useMemo(() => {
    void tick;
    return {
      ...fixture.docs,
      setActiveDocument: fixture.setActiveDocument,
      ...(fixture.locks ? { sourceControl: fixture.locks } : {}),
      ...(fixture.sync ? { sourceControlSync: fixture.sync } : {}),
    };
  }, [tick]);
}

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(useLiveDocs));

vi.mock("../context/project-search-context", () => ({
  useProjectSearch: () => ({ pendingTarget: null, clearPendingTarget: vi.fn() }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ diagnostics: [] }),
}));

function asset(path: string, name: string, type: string): IndexedAsset {
  return {
    rootId: "project",
    path,
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [],
      guid: name.toLowerCase(),
      type,
      name,
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [],
    },
  };
}

const NO_EXTENSIONS = { entries: [], commands: [], assetTypes: [], diagnostics: [] };

function installProject() {
  const assets = [asset(FOREST, "Forest", "Scene"), asset(ROCK, "Rock", "Texture"), asset(CAVE, "Cave", "Scene")];
  const root = projectContentRoot();
  fixture.docs = {
    projectGuid: "project",
    projectDocument: { settings: { pluginOverrides: {}, gameInstanceClass: null, editorUtilityObjects: [], startupSceneGuid: "" } },
    assetRegistry: {
      getRoot: (id: string) => (id === "project" ? root : undefined),
      list: () => assets,
      folderTree: () => ({ name: "assets", path: "assets", children: [], assets: assets.map((entry) => entry.header.guid) }),
      getByGuid: (guid: string) => assets.find((entry) => entry.header.guid === guid),
    },
    registryEpoch: 1,
    encodingTextures: new Set<string>(),
    thumbnailsEnabled: false,
    thumbnailVersions: {},
    pluginDescriptors: [],
    showPluginContent: false,
    activeDocumentId: "content-browser",
    tabOrder: [],
    extensionService: {
      subscribe: () => () => {},
      getSnapshot: () => NO_EXTENSIONS,
    },
  };
}

/** A lock service for the project's repository, in `mode`, with Rock locked by Bob. */
async function lockService(mode: "manual" | "integrated"): Promise<SourceControlService> {
  const service = new SourceControlService();
  const fake = new FakeLockProvider({ selfName: "Ada" });
  fake.addTheirs(ROCK, "Bob");
  await service.configure({ settings: { ...MANUAL_SOURCE_CONTROL, mode }, projectKey: "project", platform: "electron", testMode: true, hosts: await signedInHosts(), fake });
  // Integrated locks name the checked-out branch.
  if (mode === "integrated") service.setCheckedOutBranch("main");
  await service.refresh();
  return service;
}

function renderBrowser() {
  return render(
    <KeybindProvider>
      <SourceControlActionsProvider>
        <ContentBrowserWorkspace />
      </SourceControlActionsProvider>
    </KeybindProvider>,
  );
}

const tile = (path: string) => screen.getByTestId(`content-item-${path}`);

/** Right-clicks the tile and opens its Source Control submenu; the submenu's panel. */
function openSourceControlMenu(path: string): HTMLElement {
  fireEvent.contextMenu(tile(path), { clientX: 20, clientY: 20 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Source Control" }));
  return screen.getByTestId("context-menu-sub-source-control");
}

/** A menu panel's entries in order: labels in brackets, disabled actions marked. */
function entries(panel: HTMLElement): string[] {
  return [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
    item.tagName === "BUTTON" ? `${item.textContent}${(item as HTMLButtonElement).disabled ? " (disabled)" : ""}` : `[${item.textContent}]`);
}

afterEach(() => {
  cleanup();
  fixture.locks?.dispose();
  fixture.locks = null;
  fixture.sync?.dispose();
  fixture.sync = null;
  fixture.setActiveDocument.mockReset();
});

describe("Content Browser Source Control", () => {
  it("offers no Source Control submenu while Source Control is Off", () => {
    installProject();
    renderBrowser();
    fireEvent.contextMenu(tile(FOREST), { clientX: 20, clientY: 20 });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Source Control" })).toBeNull();
  });

  it("locks and releases an asset from its menu, naming who holds it, and shows the badge on its tile", async () => {
    installProject();
    fixture.locks = await lockService("manual");
    renderBrowser();
    // Someone else's lock: an outlined badge named for the holder.
    expect(within(tile(ROCK)).getByRole("img", { name: "Locked By Bob" }).dataset.lockState).toBe("theirs");

    let panel = openSourceControlMenu(FOREST);
    // Manual mode: locks only.
    expect(entries(panel)).toEqual(["Lock"]);
    await act(async () => {
      fireEvent.click(within(panel).getByRole("menuitem", { name: "Lock" }));
    });
    expect(fixture.locks.lockStateForPath(FOREST)).toBe("mine");
    await waitFor(() => expect(within(tile(FOREST)).getByRole("img", { name: "Locked By You" }).dataset.lockState).toBe("mine"));

    panel = openSourceControlMenu(FOREST);
    expect(entries(panel)).toEqual(["[Locked By You]", "Release Lock"]);
    await act(async () => {
      fireEvent.click(within(panel).getByRole("menuitem", { name: "Release Lock" }));
    });
    expect(fixture.locks.lockStateForPath(FOREST)).toBeNull();
    await waitFor(() => expect(within(tile(FOREST)).queryByRole("img", { name: /^Locked By/ })).toBeNull());
  });

  it("names someone else's lock and force unlocks it only after the confirmation", async () => {
    installProject();
    fixture.locks = await lockService("manual");
    renderBrowser();
    const panel = openSourceControlMenu(ROCK);
    expect(entries(panel)).toEqual(["[Locked By Bob]", "Force Unlock…"]);
    fireEvent.click(within(panel).getByRole("menuitem", { name: "Force Unlock…" }));
    const confirm = await screen.findByTestId("locks-force-unlock-confirm");
    expect(confirm.textContent).toContain(`${ROCK} is locked by Bob`);
    expect(fixture.locks.lockStateForPath(ROCK)).toBe("theirs");
    await act(async () => {
      fireEvent.click(screen.getByTestId("locks-force-unlock-confirm-action"));
    });
    expect(fixture.locks.lockStateForPath(ROCK)).toBeNull();
  });

  it("marks added and modified assets in Integrated mode and opens a changed asset's diff from its menu", async () => {
    installProject();
    const { service, storage } = await integratedSync();
    await storage.writeText(FOREST, "F2");
    await storage.writeText(CAVE, "C");
    await service.refreshStatus();
    fixture.sync = service;
    fixture.locks = await lockService("integrated");
    renderBrowser();
    expect(within(tile(CAVE)).getByRole("img", { name: "Added" }).querySelector(".lucide-plus")).not.toBeNull();
    expect(within(tile(FOREST)).getByRole("img", { name: "Modified" }).textContent).toBe("M");
    expect(within(tile(ROCK)).queryByRole("img", { name: /Added|Modified/ })).toBeNull();

    // An unchanged asset has nothing to show or revert.
    expect(entries(openSourceControlMenu(ROCK))).toEqual(["[Locked By Bob]", "Force Unlock…", "Show Changes (disabled)", "Show History", "Revert… (disabled)"]);
    fireEvent.keyDown(screen.getByTestId("context-menu-sub-source-control"), { key: "Escape" });

    const panel = openSourceControlMenu(FOREST);
    expect(entries(panel)).toEqual(["Lock", "Show Changes", "Show History", "Revert…"]);
    fireEvent.click(within(panel).getByRole("menuitem", { name: "Show Changes" }));
    expect(fixture.setActiveDocument).toHaveBeenCalledWith(SOURCE_CONTROL_ID);
  });

  it("follows a commit: a committed asset loses its marker", async () => {
    installProject();
    const { service, storage } = await integratedSync();
    await storage.writeText(CAVE, "C");
    await service.refreshStatus();
    fixture.sync = service;
    fixture.locks = await lockService("integrated");
    renderBrowser();
    expect(within(tile(CAVE)).getByRole("img", { name: "Added" })).toBeTruthy();
    await act(async () => {
      await service.commit({ rowIds: new Set([CAVE]), message: "Cave", push: false });
    });
    await waitFor(() => expect(within(tile(CAVE)).queryByRole("img", { name: "Added" })).toBeNull());
  });

  it("locks or releases several selected assets together", async () => {
    installProject();
    fixture.locks = await lockService("manual");
    await fixture.locks.lockPaths([CAVE]);
    renderBrowser();
    fireEvent.click(tile(FOREST));
    fireEvent.click(tile(CAVE), { ctrlKey: true });
    const panel = openSourceControlMenu(CAVE);
    expect(entries(panel)).toEqual(["Lock", "Release Lock"]);
    await act(async () => {
      fireEvent.click(within(panel).getByRole("menuitem", { name: "Lock" }));
    });
    expect(fixture.locks.lockStateForPath(FOREST)).toBe("mine");
    expect(fixture.locks.lockStateForPath(CAVE)).toBe("mine");
  });
});
