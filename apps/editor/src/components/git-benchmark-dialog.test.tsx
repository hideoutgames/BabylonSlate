import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createEmptyProject, type ProjectDocument, type SourceControlProjectSettings } from "@haptic/core";
/** The settings the dialog module reads: after `freshDialog` resets the module registry, that registry's copy. */
const recordRun = async (run: { stage: string; startedAt: string } | null) =>
  (await import("../context/app-settings-context")).receiveActiveAppSettingsUpdate({ gitBenchmarkRun: run });
import type { EditorGitBenchmarkOptions, EditorGitBenchmarkResult } from "../lib/git-benchmark-runner";

const harness = vi.hoisted(() => ({
  /** How often the runner module was evaluated: it must not load before Run. */
  runnerLoads: 0,
  run: vi.fn<(options: EditorGitBenchmarkOptions) => Promise<EditorGitBenchmarkResult>>(),
  project: null as ProjectDocument | null,
}));

// The runner clones and pushes through the device's storage, native HTTP and saved credential. The dialog's contract
// is when it loads the runner, what it asks it for and what it shows of the answer.
function runnerModule() {
  harness.runnerLoads += 1;
  return { runGitBenchmarkInEditor: harness.run };
}
vi.mock("../lib/git-benchmark-runner", () => runnerModule());
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({ projectName: "Game", projectDocument: harness.project })));

const writeText = vi.fn<(text: string) => Promise<void>>();
let clipboard: PropertyDescriptor | undefined;

beforeEach(async () => {
  await recordRun(null);
  harness.run.mockReset();
  harness.project = null;
  clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  writeText.mockReset().mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function projectWith(sourceControl: Partial<SourceControlProjectSettings>): ProjectDocument {
  const project = createEmptyProject("Game");
  project.settings.sourceControl = { ...project.settings.sourceControl, ...sourceControl };
  return project;
}

/**
 * A fresh dialog module and runner mock (a mocked module outlives `resetModules`), so runner loads are counted from
 * zero whichever test ran Run before.
 */
async function freshDialog() {
  vi.resetModules();
  vi.doMock("../lib/git-benchmark-runner", runnerModule);
  harness.runnerLoads = 0;
  return (await import("./git-benchmark-dialog")).GitBenchmarkDialog;
}

const MIB = 1024 * 1024;
const RESULT: EditorGitBenchmarkResult = {
  transfer: "native",
  files: 2400,
  unchangedStatusChanges: 0,
  clone: { ms: 12_400, sent: 2048, received: 85 * MIB, workingReads: 0 },
  status: { ms: 640, sent: 0, received: 0, workingReads: 0 },
  commit: { ms: 210, sent: 0, received: 0, workingReads: 1 },
  push: { ms: 1_100, sent: 4096, received: 1024, workingReads: 0 },
  createObjects: { ms: 1_500, objects: 3, bytes: 96 * MIB },
  lfsCommit: { ms: 300, sent: 0, received: 0, workingReads: 0 },
  lfsUpload: { ms: 9_300, sent: 96 * MIB, received: 2048, workingReads: 0, objects: 3, bytes: 96 * MIB },
  lfsDownload: { ms: 7_900, sent: 1024, received: 96 * MIB, workingReads: 0, objects: 3, bytes: 96 * MIB },
  leftovers: "Branch haptic-benchmark-20261115120000 (two commits) and 3 LFS objects of 33554432 bytes on the host; delete the branch there.",
  memory: {
    clone: { appFootprintBytes: 300 * MIB, appAvailableBytes: 2048 * MIB },
    "lfs-upload": { appFootprintBytes: 410 * MIB, appAvailableBytes: 1900 * MIB },
  },
};

const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

describe("GitBenchmarkDialog", () => {
  it.each([
    ["an Integrated project's repository and default branch", { mode: "integrated", repositoryUrl: "https://github.com/acme/game.git", branch: "develop" }, "https://github.com/acme/game.git", "develop"],
    ["a Manual project's repository and branch", { mode: "manual", repositoryUrl: "https://gitlab.com/acme/game.git", branch: "trunk" }, "https://gitlab.com/acme/game.git", "trunk"],
    ["an Off project's repository and branch, which Project Settings still shows", { mode: "off", repositoryUrl: "https://github.com/acme/old.git", branch: "develop" }, "https://github.com/acme/old.git", "develop"],
    ["nothing from a project without a repository", { mode: "manual", repositoryUrl: "", branch: "trunk" }, "", "main"],
  ] as const)("prefills %s", async (_name, sourceControl, url, branch) => {
    harness.project = projectWith(sourceControl);
    const { GitBenchmarkDialog } = await import("./git-benchmark-dialog");
    render(<GitBenchmarkDialog open onOpenChange={vi.fn()} />);
    expect(field("git-benchmark-repository").value).toBe(url);
    expect(field("git-benchmark-branch").value).toBe(branch);
    expect(field("git-benchmark-blobs").value).toBe("3");
    expect(field("git-benchmark-blob-mib").value).toBe("32 MiB");
    expect((screen.getByTestId("git-benchmark-run") as HTMLButtonElement).disabled).toBe(url === "");
    expect(screen.getByTestId("git-benchmark-warning").textContent).toContain("haptic-benchmark-");
  });

  it("loads the runner only on Run, runs it with the form's values, survives closing and shows the results to copy", async () => {
    harness.project = projectWith({ mode: "integrated", repositoryUrl: "https://github.com/acme/game.git", branch: "develop" });
    let finish: (result: EditorGitBenchmarkResult) => void = () => {};
    harness.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const GitBenchmarkDialog = await freshDialog();
    const { rerender } = render(<GitBenchmarkDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(field("git-benchmark-blobs"), { target: { value: "2" } });
    fireEvent.change(field("git-benchmark-blob-mib"), { target: { value: "8" } });
    expect(harness.runnerLoads).toBe(0);

    fireEvent.click(screen.getByTestId("git-benchmark-run"));
    await waitFor(() => expect(harness.run).toHaveBeenCalledTimes(1));
    expect(harness.runnerLoads).toBe(1);
    expect(harness.run).toHaveBeenCalledWith({ repositoryUrl: "https://github.com/acme/game.git", branch: "develop", blobs: 2, blobMiB: 8 });
    expect(screen.getByTestId("git-benchmark-progress").textContent).toContain("Running…");
    expect(screen.getByText("https://github.com/acme/game.git · develop")).toBeTruthy();

    // A run cannot be cancelled: closing hides it, and reopening shows it still running, not a fresh form.
    rerender(<GitBenchmarkDialog open={false} onOpenChange={vi.fn()} />);
    rerender(<GitBenchmarkDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByTestId("git-benchmark-progress")).toBeTruthy();
    expect(screen.queryByTestId("git-benchmark-repository")).toBeNull();

    finish(RESULT);
    const results = await screen.findByTestId("git-benchmark-results") as HTMLTextAreaElement;
    expect(results.readOnly).toBe(true);
    expect(JSON.parse(results.value)).toEqual(RESULT);
    expect(results.value).toContain('\n  "files": 2400,\n');
    const gate = screen.getByTestId("git-benchmark-gate");
    expect(gate.getAttribute("data-passed")).toBe("true");
    expect(within(gate).getByText("Unchanged Status Passed")).toBeTruthy();
    expect(gate.textContent).toContain("It read 0 files.");
    const summary = screen.getByTestId("git-benchmark-summary").textContent;
    expect(summary).toContain("Files2400");
    expect(summary).toContain("Clone12.4 s · 0.0 MiB sent, 85.0 MiB received");
    expect(summary).toContain("Status640 ms");
    expect(summary).toContain("LFS Upload9.3 s · 3 objects, 96.0 MiB");
    expect(summary).toContain("LFS TransferNative, between file and network");
    const memory = screen.getByTestId("git-benchmark-memory").textContent;
    expect(memory).toContain("Clone300.0 MiB app · 2048.0 MiB left");
    expect(memory).toContain("LFS Upload410.0 MiB app · 1900.0 MiB left");
    expect(memory).not.toContain("Status");

    fireEvent.click(screen.getByTestId("git-benchmark-copy"));
    await waitFor(() => expect(screen.getByTestId("git-benchmark-copy").textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith(results.value);
  });

  it.each([
    ["read working files", { status: { ...RESULT.status, workingReads: 3 } }, "It read 3 files; it must read none."],
    ["found changes", { unchangedStatusChanges: 2 }, "It read 0 files. It found 2 changes in the unchanged tree; it must find none."],
  ] as const)("fails the unchanged status check when it %s", async (_name, patch, text) => {
    harness.project = projectWith({ mode: "integrated", repositoryUrl: "https://github.com/acme/game.git", branch: "main" });
    harness.run.mockResolvedValue({ ...RESULT, ...patch });
    const { GitBenchmarkDialog } = await import("./git-benchmark-dialog");
    render(<GitBenchmarkDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("git-benchmark-run"));
    const gate = await screen.findByTestId("git-benchmark-gate");
    expect(gate.getAttribute("data-passed")).toBe("false");
    expect(within(gate).getByText("Unchanged Status Failed")).toBeTruthy();
    expect(gate.textContent).toContain(text);
  });

  it("shows a failed run's message to copy, and Run Again keeps the form's values", async () => {
    harness.run.mockRejectedValue(new Error("No saved credential for https://github.com."));
    const { GitBenchmarkDialog } = await import("./git-benchmark-dialog");
    render(<GitBenchmarkDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(field("git-benchmark-repository"), { target: { value: "https://github.com/acme/bench.git" } });
    fireEvent.click(screen.getByTestId("git-benchmark-run"));
    const error = await screen.findByTestId("git-benchmark-error");
    expect(error.textContent).toContain("No saved credential for https://github.com.");
    expect(screen.queryByTestId("git-benchmark-results")).toBeNull();

    fireEvent.click(screen.getByTestId("git-benchmark-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("No saved credential for https://github.com."));

    fireEvent.click(screen.getByTestId("git-benchmark-again"));
    expect(field("git-benchmark-repository").value).toBe("https://github.com/acme/bench.git");
  });

  it("refuses a URL that names no repository without loading the runner", async () => {
    const GitBenchmarkDialog = await freshDialog();
    render(<GitBenchmarkDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(field("git-benchmark-repository"), { target: { value: "not a repository" } });
    fireEvent.click(screen.getByTestId("git-benchmark-run"));
    expect(await screen.findByText("Not a repository URL.")).toBeTruthy();
    expect(field("git-benchmark-repository").getAttribute("aria-invalid")).toBe("true");
    await Promise.resolve();
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.runnerLoads).toBe(0);
  });

  // The runner records each stage before it starts and clears the record when the run ends, failed or not.
  it("names the stage a run the app did not survive stopped in, without loading the runner", async () => {
    const GitBenchmarkDialog = await freshDialog();
    await recordRun({ stage: "lfs-upload", startedAt: "2026-11-16T09:30:00.000Z" });
    render(<GitBenchmarkDialog open onOpenChange={vi.fn()} />);
    const notice = screen.getByTestId("git-benchmark-interrupted");
    expect(within(notice).getByText("Last Run Stopped During LFS Upload")).toBeTruthy();
    expect(notice.textContent).toContain("most likely out of memory");
    expect(harness.runnerLoads).toBe(0);

    await recordRun(null);
    await waitFor(() => expect(screen.queryByTestId("git-benchmark-interrupted")).toBeNull());
  });

  it("shows the stage a running benchmark is in", async () => {
    harness.project = projectWith({ mode: "integrated", repositoryUrl: "https://github.com/acme/game.git", branch: "main" });
    harness.run.mockImplementation(() => new Promise(() => {}));
    const { GitBenchmarkDialog } = await import("./git-benchmark-dialog");
    render(<GitBenchmarkDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("git-benchmark-run"));
    expect((await screen.findByTestId("git-benchmark-progress")).textContent).toContain("Running…");
    await recordRun({ stage: "create-objects", startedAt: "2026-11-16T09:30:00.000Z" });
    await waitFor(() => expect(screen.getByTestId("git-benchmark-progress").textContent).toContain("Create LFS Objects…"));
    expect(screen.queryByTestId("git-benchmark-interrupted")).toBeNull();
  });
});
