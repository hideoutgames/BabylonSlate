import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFolderHandle } from "@haptic/core";
import { MemoryAppSettingsStore } from "@haptic/vfs/test-support/memory-app-settings";
import type { ProjectService } from "../services/project-service";
import { useProjectList } from "./use-project-list";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { createEmptyProject, type ProjectStorage } from "@haptic/core";

let derived: ProjectStorage;
beforeEach(async () => {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("__haptic_derived__");
  derived = storage;
});

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
    const { result } = renderHook(() => useProjectList({ projectService, settingsStore, route: "home", ensureDerived: async () => derived }));

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
    const { result } = renderHook(() => useProjectList({ projectService, settingsStore, route: "home", ensureDerived: async () => derived }));

    await expect(act(() => result.current.actions.removeListedProject(PROJECTS[1]!))).rejects.toThrow("busy");
    expect((await settingsStore.load()).recents.map((recent) => recent.id)).toEqual(["documents:Local"]);
  });
});

describe("useProjectList recent pictures", () => {
  it("keeps a recent's picture in derived storage, not in app settings, and drops it with the recent", async () => {
    const settingsStore = new MemoryAppSettingsStore();
    const handle = PROJECTS[0]!;
    const projectService = {
      listProjects: vi.fn(async () => [handle]),
      needsReconnect: vi.fn(async () => false),
      deleteListedProject: vi.fn(async () => {}),
    } as unknown as ProjectService;
    const { result } = renderHook(() => useProjectList({ projectService, settingsStore, route: "home", ensureDerived: async () => derived }));
    const image = "data:image/webp;base64,UklGRg==";
    const metadata = { ...createEmptyProject("Web").metadata, appearance: { icon: "box", color: "mint", coverFile: "cover.webp" as const, image } };

    await act(() => result.current.recordRecent(handle, metadata, false));
    const [recent] = (await settingsStore.load()).recents;
    expect(recent!.appearance).toEqual({ icon: "box", color: "mint", coverFile: "cover.webp" });
    expect(JSON.stringify(await settingsStore.load())).not.toContain("UklGRg");
    expect(Array.from(await derived.readBinary("recent-covers/opfs%3AWeb"))).toEqual([0x52, 0x49, 0x46, 0x46]);

    await act(() => result.current.refreshProjectList());
    expect(result.current.listedProjects[0]!.appearance).toMatchObject({ coverFile: "cover.webp", image });

    await act(() => result.current.actions.removeListedProject(handle));
    expect(await derived.exists("recent-covers/opfs%3AWeb")).toBe(false);
  });
});
