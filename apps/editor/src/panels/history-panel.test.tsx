import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceControlSyncService } from "../services/source-control-sync";
import type { DiffState } from "../services/source-control-diff";
import { integratedSync } from "../testing/integrated-sync";
import { SourceControlActionsProvider, useSourceControlActions, useSourceControlDiffState, type SourceControlActions } from "../components/source-control-actions";
import { HISTORY_PAGE, HistoryPanelContents } from "./history-panel";

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
    expect((await within(details).findByTestId("history-assets")).textContent).toContain("Forest");

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
    expect((await read.mock.results[1]!.value).commits.map((commit: { message: string }) => commit.message)).toEqual(["Rock 1", "Rock 0", "Seed"]);
  });
});
