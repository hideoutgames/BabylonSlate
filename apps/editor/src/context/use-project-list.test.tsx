import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectFolderHandle } from "@haptic/core";
import { MemoryAppSettingsStore } from "@haptic/vfs";
import type { ProjectService } from "../services/project-service";
import { useProjectList } from "./use-project-list";

const PROJECTS: ProjectFolderHandle[] = [
  { id: "opfs:Web", name: "Web", tier: "opfs" },
  { id: "documents:Local", name: "Local", tier: "documents" },
  { id: "node:/picked/Picked", name: "Picked", tier: "external" },
];

describe("useProjectList removeListedProject", () => {
  it.each([
    [PROJECTS[0]!, 1, ["documents:Local", "node:/picked/Picked"]],
    [PROJECTS[1]!, 1, ["opfs:Web", "node:/picked/Picked"]],
    [PROJECTS[2]!, 0, ["opfs:Web", "documents:Local"]],
  ] as const)("drops the recent of %o and deletes its storage %i time(s)", async (handle, deletes, remaining) => {
    const settingsStore = new MemoryAppSettingsStore();
    await settingsStore.update((settings) => {
      settings.recents = PROJECTS.map((project) => ({
        id: project.id,
        name: project.name,
        tier: project.tier,
        lastOpenedAt: "2026-11-06T00:00:00.000Z",
        bookmark: null,
      }));
    });
    const deleteListedProject = vi.fn(async () => {});
    const projectService = {
      listProjects: vi.fn(async () => PROJECTS.filter((project) => project.tier !== "external")),
      needsReconnect: vi.fn(async () => false),
      deleteListedProject,
    } as unknown as ProjectService;
    const { result } = renderHook(() => useProjectList({ projectService, settingsStore, route: "home" }));

    await act(() => result.current.actions.removeListedProject(handle));

    expect(deleteListedProject).toHaveBeenCalledTimes(deletes);
    if (deletes) expect(deleteListedProject).toHaveBeenCalledWith(handle);
    expect((await settingsStore.load()).recents.map((recent) => recent.id)).toEqual(remaining);
  });

  it("keeps the recent when deleting fails, so the card stays for another try", async () => {
    const settingsStore = new MemoryAppSettingsStore();
    await settingsStore.update((settings) => {
      settings.recents = [{ id: "documents:Local", name: "Local", tier: "documents", lastOpenedAt: "2026-11-06T00:00:00.000Z", bookmark: null }];
    });
    const projectService = {
      listProjects: vi.fn(async () => [PROJECTS[1]!]),
      needsReconnect: vi.fn(async () => false),
      deleteListedProject: vi.fn(async () => { throw new Error("busy"); }),
    } as unknown as ProjectService;
    const { result } = renderHook(() => useProjectList({ projectService, settingsStore, route: "home" }));

    await expect(act(() => result.current.actions.removeListedProject(PROJECTS[1]!))).rejects.toThrow("busy");
    expect((await settingsStore.load()).recents.map((recent) => recent.id)).toEqual(["documents:Local"]);
  });
});
