import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLDER_MARKER_NAME } from "@haptic/assets";
import { PROJECT_FILE } from "@haptic/core";
import type { SourceControlSyncService } from "../services/source-control-sync";
import type { DiffState } from "../services/source-control-diff";
import { integratedProjectJson, integratedSync } from "../testing/integrated-sync";
import { SourceControlActionsProvider, useSourceControlActions, useSourceControlDiffState, type SourceControlActions } from "../components/source-control-actions";
import { HistoryPanelContents } from "./history-panel";
import { HISTORY_PAGE } from "../services/source-control-history";

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
}));

const headers: Record<string, { name: string; type: string; chunks: [] }> = {
  "assets/Forest.scene.hasset": { name: "Forest", type: "Scene", chunks: [] },
  "assets/Rock.texture.hasset": { name: "Rock", type: "Texture", chunks: [] },
};

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    ...(state.sync ? { sourceControlSync: state.sync } : {}),
    assetRegistry: { getByPath: (path: string) => (headers[path] ? { path, header: headers[path] } : undefined) } as never,
  })),
);

afterEach(() => {
  cleanup();
  state.sync?.dispose();
  state.sync = null;
});

const FOREST = "assets/Forest.scene.hasset";
const ROCK = "assets/Rock.texture.hasset";

/** What the window's actions did: the open diff and the History asset. */
const seen: { actions: SourceControlActions | null; diff: DiffState | null } = { actions: null, diff: null };
function Probe() {
  seen.actions = useSourceControlActions();
  seen.diff = useSourceControlDiffState();
  return null;
}

async function history() {
  const sync = await integratedSync();
  state.sync = sync.service;
  const { service, storage } = sync;
  await storage.writeText(FOREST, "F2");
  await service.commit({ rowIds: new Set([FOREST]), message: "Brighten the forest\n\nThe sun was too dim.", push: false });
  await storage.writeText(ROCK, "R2");
  await service.commit({ rowIds: new Set([ROCK]), message: "Rougher rock", push: false });
  await storage.writeText(FOREST, "F3");
  await service.refreshStatus();
  render(
    <SourceControlActionsProvider>
      <HistoryPanelContents />
      <Probe />
    </SourceControlActionsProvider>,
  );
  act(() => seen.actions!.openHistory(FOREST));
  return sync;
}

function rowIds(): string[] {
  return within(screen.getByTestId("history-list")).getAllByRole("button").map((row) => row.getAttribute("data-testid")!.replace("history-row-", ""));
}

describe("History window at the end of a shallow clone", () => {
  const commit = (id: string, message: string) => ({ id: id.padStart(40, "0"), message, author: { name: "Sam", email: "" }, timestamp: 1_700_000_000, parents: [] });

  it("reads the pages again with older history, since that may drop the clone's commit, and keeps Load Older History while more may come", async () => {
    const sync = await integratedSync();
    state.sync = sync.service;
    const read = vi.spyOn(sync.service, "history")
      .mockResolvedValueOnce({ commits: [commit("c", "Cloned")], hasMore: true, shallow: true })
      // Older history showed the clone's commit did not change it; nothing older that did is downloaded yet.
      .mockResolvedValueOnce({ commits: [commit("b", "Older")], hasMore: true, shallow: true });
    render(
      <SourceControlActionsProvider>
        <HistoryPanelContents />
      </SourceControlActionsProvider>,
    );
    const older = await screen.findByTestId("history-load-older");
    expect(screen.getByText("Older history is not downloaded yet.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(older);
    });
    expect(read.mock.calls.map(([options]) => options)).toEqual([{ limit: HISTORY_PAGE }, { limit: 1 + HISTORY_PAGE, deepen: true }]);
    await waitFor(() => expect(rowIds()).toEqual([commit("b", "").id]));
    expect(screen.getByTestId("history-load-older")).toBeTruthy();
  });
});

describe("History window", () => {
  it("lists the asset's commits newest first after its uncommitted changes, and the chosen commit's message, author, id and assets", async () => {
    const { service } = await history();
    const commits = (await service.history({ limit: 10 })).commits;
    const [rock, forest, seed] = commits;
    expect(screen.getByTestId("history-title").textContent).toBe("Forest");
    await waitFor(() => expect(rowIds()).toEqual(["working", forest!.id, seed!.id]));

    fireEvent.click(screen.getByTestId(`history-row-${forest!.id}`));
    const details = screen.getByTestId("history-details");
    expect(details.textContent).toContain("Brighten the forest");
    expect(details.textContent).toContain("The sun was too dim.");
    expect(details.textContent).toContain("ada");
    expect(details.textContent).toContain(forest!.id.slice(0, 7));
    const assets = await within(details).findByTestId("history-assets");
    expect(assets.textContent).toContain("Forest");
    expect(within(assets).getByRole("img", { name: "Modified" }).textContent).toBe("M");

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await act(async () => {
      fireEvent.click(within(details).getByTestId("history-copy-id"));
    });
    expect(writeText).toHaveBeenCalledWith(forest!.id);

    // All Assets: the branch's commits, Rock's too.
    fireEvent.click(screen.getByTestId("history-scope-all"));
    await waitFor(() => expect(rowIds()).toEqual(["working", rock!.id, forest!.id, seed!.id]));
    expect(screen.getByTestId("history-title").textContent).toBe("All Assets");
    // Compare and Revert act on one asset, which All Assets does not name.
    expect(screen.getByTestId("history-details").textContent).toContain("Brighten the forest");
    expect(screen.queryByTestId("history-compare")).toBeNull();
    expect(screen.queryByTestId("history-revert")).toBeNull();

    // The first commit added its assets: each is marked with a plus, not a letter.
    fireEvent.click(screen.getByTestId(`history-row-${seed!.id}`));
    const seeded = await within(screen.getByTestId("history-details")).findByTestId("history-asset-assets/Forest.scene.hasset");
    expect(within(seeded).getByRole("img", { name: "Added" }).querySelector(".lucide-plus")).not.toBeNull();
    expect(seeded.textContent).not.toMatch(/A$/);
  });

  it("compares the asset at a commit with the working copy, and reverts it to that version after a confirmation", async () => {
    const { service } = await history();
    const forest = (await service.history({ limit: 1, path: FOREST })).commits[0]!;
    fireEvent.click(await screen.findByTestId(`history-row-${forest.id}`));
    fireEvent.click(screen.getByTestId("history-compare"));
    expect(seen.diff?.target).toMatchObject({ path: FOREST, name: "Forest", base: { kind: "commit", id: forest.id }, compare: { kind: "working" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("history-revert"));
    });
    const confirm = await screen.findByTestId("source-control-revert-confirm");
    expect(confirm.textContent).toContain("Revert Forest?");
    expect(confirm.textContent).toContain(forest.id.slice(0, 7));
  });

  it("follows Project Settings in This Asset, with Compare and Revert, and keeps folder markers out", async () => {
    const { service, storage } = await history();
    await storage.writeText(PROJECT_FILE, integratedProjectJson({ autoSave: false }));
    await service.commit({ rowIds: new Set([PROJECT_FILE]), message: "Turn Auto-Save off", push: false });
    const settings = (await service.history({ limit: 1, path: PROJECT_FILE })).commits[0]!;
    // The Changes window's Project Settings row opens its diff, and History follows project.json.
    act(() => seen.actions!.openDiff({ path: PROJECT_FILE, name: "Project Settings", type: "Project" }));
    expect(seen.actions!.historyPath).toBe(PROJECT_FILE);
    expect(screen.getByTestId("history-title").textContent).toBe("Project Settings");
    await waitFor(() => expect(rowIds()).toEqual([settings.id]));

    fireEvent.click(screen.getByTestId(`history-row-${settings.id}`));
    fireEvent.click(await screen.findByTestId("history-compare"));
    expect(seen.diff?.target).toMatchObject({ path: PROJECT_FILE, name: "Project Settings", base: { kind: "commit", id: settings.id }, compare: { kind: "working" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("history-revert"));
    });
    const confirm = await screen.findByTestId("source-control-revert-confirm");
    expect(confirm.textContent).toContain("Revert Project Settings?");
    expect(confirm.textContent).toContain("then the project reloads");

    // A folder marker has no history to follow.
    act(() => seen.actions!.openHistory(`assets/Levels/${FOLDER_MARKER_NAME}`));
    expect(seen.actions!.historyPath).toBe(PROJECT_FILE);
  });

  it("offers no This Asset before an asset was shown, when only a file that is not one was", async () => {
    const sync = await integratedSync();
    state.sync = sync.service;
    render(
      <SourceControlActionsProvider>
        <HistoryPanelContents />
        <Probe />
      </SourceControlActionsProvider>,
    );
    act(() => seen.actions!.openDiff({ path: `assets/Levels/${FOLDER_MARKER_NAME}`, name: "Levels", type: "Folder" }));
    act(() => seen.actions!.openHistory());
    expect(screen.getByTestId("history-title").textContent).toBe("All Assets");
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
    expect((screen.getByTestId("history-scope-asset") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("history-revert")).toBeNull();
  });

  it("reads its list again when the pickers' reads of other assets pushed it out of the shared lists", async () => {
    const sync = await integratedSync();
    state.sync = sync.service;
    render(
      <SourceControlActionsProvider>
        <HistoryPanelContents />
      </SourceControlActionsProvider>,
    );
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
    act(() => {
      for (let index = 0; index < 8; index += 1) sync.service.commitHistory.load(`assets/Other${index}.hasset`);
    });
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
    expect(sync.service.commitHistory.list(null)?.ready).toBe(true);
  });

  it("reads one page of the log, and the next only when asked", async () => {
    const sync = await integratedSync();
    state.sync = sync.service;
    for (let index = 0; index < HISTORY_PAGE + 2; index += 1) sync.remote.commit({ [ROCK]: `R${index}` }, `Rock ${index}`);
    await sync.service.pull();
    const read = vi.spyOn(sync.service, "history");
    render(
      <SourceControlActionsProvider>
        <HistoryPanelContents />
      </SourceControlActionsProvider>,
    );
    const older = await screen.findByTestId("history-load-older");
    expect(read.mock.calls.map(([options]) => options)).toEqual([{ limit: HISTORY_PAGE }]);
    await act(async () => {
      fireEvent.click(older);
    });
    await waitFor(() => expect(screen.queryByTestId("history-load-older")).toBeNull());
    expect(read.mock.calls.map(([options]) => options)).toEqual([{ limit: HISTORY_PAGE }, { limit: HISTORY_PAGE, skip: HISTORY_PAGE, deepen: true }]);
    // Rock 51 to Rock 2 came first; the rest of the 53 now.
    expect(read).toHaveBeenCalledTimes(2);
    expect((await read.mock.results[1]!.value).commits.map((commit: { message: string }) => commit.message)).toEqual(["Rock 1", "Rock 0", "Seed"]);
  });
});
