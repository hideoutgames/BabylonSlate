import { afterEach, describe, expect, it, vi } from "vitest";
import { integratedSync } from "../testing/integrated-sync";
import { HISTORY_PAGE } from "./source-control-history";
import type { SourceControlSyncService } from "./source-control-sync";

const ROCK = "assets/Rock.texture.hasset";
let open: SourceControlSyncService | null = null;

afterEach(() => {
  open?.dispose();
  open = null;
});

describe("CommitHistory", () => {
  it("reads an asset's list once for the commit checked out, again after a commit moves it, and again after a failed first page", async () => {
    const { service, storage } = await integratedSync();
    open = service;
    const read = vi.spyOn(service, "history");
    const lists = service.commitHistory;

    lists.load(ROCK);
    lists.load(ROCK);
    await vi.waitFor(() => expect(lists.list(ROCK)?.ready).toBe(true));
    expect(lists.list(ROCK)!.commits.map((commit) => commit.message)).toEqual(["Seed"]);
    expect(read).toHaveBeenCalledTimes(1);

    // A commit moves HEAD: the list read before belongs to another commit.
    await storage.writeText(ROCK, "R2");
    await service.commit({ rowIds: new Set([ROCK]), message: "Rougher rock", push: false });
    expect(lists.list(ROCK)).toBeNull();
    read.mockRejectedValueOnce(new Error("The log could not be read."));
    lists.load(ROCK);
    await vi.waitFor(() => expect(lists.list(ROCK)?.error).toBe("The log could not be read."));
    lists.load(ROCK);
    await vi.waitFor(() => expect(lists.list(ROCK)?.commits.map((commit) => commit.message)).toEqual(["Rougher rock", "Seed"]));
    expect(read.mock.calls.map(([options]) => options)).toEqual([
      { limit: HISTORY_PAGE, path: ROCK },
      { limit: HISTORY_PAGE, path: ROCK },
      { limit: HISTORY_PAGE, path: ROCK },
    ]);
  });
});
