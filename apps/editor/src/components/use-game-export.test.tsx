import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createEmptyProject, ok, type ProjectDocument } from "@haptic/core";
import type { SaveFileResult } from "@haptic/vfs";
import type { PackagingTarget } from "../lib/packaging-targets";
import { useGameExport } from "./use-game-export";

const actions = vi.hoisted(() => ({
  exportGameArtifact: vi.fn(async () => ({ ok: true, value: { files: new Map(), appIcon: null, warnings: [] as string[] } })),
  zipExportedGame: vi.fn(async () => new Uint8Array([1])),
  updateProjectSettings: vi.fn(),
}));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => actions as never));

const save = vi.hoisted(() => ({ result: "saved" as SaveFileResult }));
vi.mock("../lib/file-export", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/file-export")>(),
  saveZipArchive: async () => save.result,
  saveExportFile: async () => save.result,
}));

const log = vi.fn();
const WEB: PackagingTarget = { id: "web", label: "Web", description: "", available: true };

function project(buildNumber: number, autoIncrementBuildNumber: boolean): ProjectDocument {
  const document = createEmptyProject("Harbour Run");
  document.settings.appIdentity = { ...document.settings.appIdentity, buildNumber, autoIncrementBuildNumber };
  return document;
}

afterEach(() => {
  cleanup();
  actions.updateProjectSettings.mockClear();
  actions.exportGameArtifact.mockClear();
  actions.zipExportedGame.mockClear();
  log.mockClear();
  vi.restoreAllMocks();
  save.result = "saved";
});

describe("useGameExport", () => {
  it("moves the Build Number on after a kept package with Auto Increment Build Number on", async () => {
    actions.exportGameArtifact.mockResolvedValueOnce(ok({ files: new Map(), appIcon: null, warnings: [] }) as never);
    const document = project(7, true);
    const { result } = renderHook(() => useGameExport(document, { manifest: null, projectGuid: "project-a", log }));
    await act(() => result.current.packageTarget(WEB));
    expect(result.current.notice).toBe("Game package saved.");
    expect(actions.updateProjectSettings).toHaveBeenCalledWith({
      appIdentity: { ...document.settings.appIdentity, buildNumber: 8 },
    });
  });

  it("keeps the Build Number when the save is cancelled, packaging fails, or Auto Increment Build Number is off", async () => {
    save.result = "cancelled";
    const auto = renderHook(() => useGameExport(project(7, true), { manifest: null, projectGuid: "project-a", log }));
    await act(() => auto.result.current.packageTarget(WEB));
    expect(auto.result.current.notice).toBeNull();

    save.result = "saved";
    actions.exportGameArtifact.mockResolvedValueOnce({ ok: false, error: { kind: "unknown", message: "No startup scene." } } as never);
    await act(() => auto.result.current.packageTarget(WEB));
    expect(auto.result.current.error).not.toBeNull();

    const manual = renderHook(() => useGameExport(project(7, false), { manifest: null, projectGuid: "project-a", log }));
    await act(() => manual.result.current.packageTarget(WEB));
    expect(manual.result.current.notice).toBe("Game package saved.");
    expect(actions.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("keeps the export's warnings when a later packaging step fails, and clears them when a new run starts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useGameExport(project(7, true), { manifest: null, projectGuid: "project-a", log }));
    actions.exportGameArtifact.mockResolvedValueOnce(ok({ files: new Map(), appIcon: null, warnings: ["Texture T_Sky is missing."] }) as never);
    actions.zipExportedGame.mockRejectedValueOnce(new Error("zip failed"));
    await act(() => result.current.packageTarget(WEB));
    expect(result.current.error).not.toBeNull();
    expect(result.current.warnings).toEqual(["Texture T_Sky is missing."]);
    expect(log).toHaveBeenCalledExactlyOnceWith("Packaging warning: Texture T_Sky is missing.");

    let finishExport!: (value: unknown) => void;
    actions.exportGameArtifact.mockReturnValueOnce(new Promise((resolve) => { finishExport = resolve; }) as never);
    let run!: Promise<void>;
    act(() => { run = result.current.packageTarget(WEB); });
    // A new run starts without the last run's warnings.
    expect(result.current.warnings).toEqual([]);
    await act(async () => {
      finishExport(ok({ files: new Map(), appIcon: null, warnings: [] }));
      await run;
    });
    expect(result.current.notice).toBe("Game package saved.");
    expect(result.current.warnings).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
