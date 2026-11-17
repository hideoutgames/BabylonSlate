import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFolderHandle } from "@haptic/core";
import type { GitBenchmarkOptions, GitBenchmarkResult, GitBenchmarkStage } from "@haptic/source-control/git-benchmark";

type Run = { stage: string; startedAt: string } | null;

const harness = vi.hoisted(() => ({
  /** This device's settings as the runner persists them. */
  settings: { gitBenchmarkRun: null as Run },
  /** The record as it stood when each stage started, and when the folder was deleted. */
  seen: [] as Array<string | null>,
  deleted: [] as string[],
  released: 0,
  failAt: null as GitBenchmarkStage | null,
}));

// The persisted settings are the boundary: a write resolves only once it is stored.
vi.mock("../context/app-settings-context", () => ({
  updateAppSettings: async (mutate: (settings: { gitBenchmarkRun: Run }) => void) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    mutate(harness.settings);
  },
}));
vi.mock("../services/source-control-accounts", () => ({
  sourceControlAccounts: async () => ({ credentialSource: () => ({ current: async () => null, renew: async () => null }) }),
}));
vi.mock("@haptic/vfs", async (importOriginal) => {
  const folder: ProjectFolderHandle = { id: "documents:Git Benchmark", name: "Git Benchmark", tier: "documents" };
  return {
    ...(await importOriginal<typeof import("@haptic/vfs")>()),
    createNativeHttp: () => async () => ({ status: 200, bodyText: "" }),
    createNativeFileTransfer: () => null,
    getHostMemoryStats: async () => ({ appFootprintBytes: 300, appAvailableBytes: 2000 }),
    createStorage: () => ({
      openDocumentsProject: async () => folder,
      deleteProject: async (handle: ProjectFolderHandle) => {
        harness.seen.push(harness.settings.gitBenchmarkRun?.stage ?? null);
        harness.deleted.push(handle.id);
      },
      releaseFolder: async () => {
        harness.released += 1;
      },
    }),
  };
});
// The benchmark itself is covered against a Git server in its own package; here it only walks its stages.
vi.mock("@haptic/source-control/git-benchmark", () => ({
  runGitBenchmark: async (options: GitBenchmarkOptions): Promise<GitBenchmarkResult> => {
    for (const stage of ["clone", "status", "lfs-upload", "lfs-download"] as const) {
      await options.onStage!(stage);
      harness.seen.push(harness.settings.gitBenchmarkRun?.stage ?? null);
      if (harness.failAt === stage) throw new Error("The LFS store refused the object (HTTP 507).");
    }
    return { transfer: "whole-body" } as GitBenchmarkResult;
  },
}));

const { runGitBenchmarkInEditor } = await import("./git-benchmark-runner");

beforeEach(() => {
  harness.settings.gitBenchmarkRun = null;
  harness.seen = [];
  harness.deleted = [];
  harness.released = 0;
  harness.failAt = null;
});

describe("runGitBenchmarkInEditor", () => {
  it("has stored each stage before it starts, and clears the record once the run is done", async () => {
    const result = await runGitBenchmarkInEditor({ repositoryUrl: "https://github.com/acme/bench.git" });
    // A crash at any point would leave the stage it was in, the scratch folder's removal included.
    expect(harness.seen).toEqual(["clone", "status", "lfs-upload", "lfs-download", "cleanup"]);
    expect(harness.settings.gitBenchmarkRun).toBeNull();
    expect(harness.deleted).toEqual(["documents:Git Benchmark"]);
    expect(harness.released).toBe(1);
    expect(result.memory.clone).toEqual({ appFootprintBytes: 300, appAvailableBytes: 2000 });
  });

  it("names the stage a failed run stopped in, and still clears the record and removes its folder", async () => {
    harness.failAt = "lfs-upload";
    await expect(runGitBenchmarkInEditor({ repositoryUrl: "https://github.com/acme/bench.git" }))
      .rejects.toThrow("Stopped during LFS Upload: The LFS store refused the object (HTTP 507).");
    expect(harness.seen).toEqual(["clone", "status", "lfs-upload", "lfs-upload"]);
    expect(harness.settings.gitBenchmarkRun).toBeNull();
    expect(harness.deleted).toEqual(["documents:Git Benchmark"]);
    expect(harness.released).toBe(1);
  });
});
