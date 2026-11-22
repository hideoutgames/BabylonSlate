import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlobReclaimResult } from "../services/project-service";
import { ProjectStorageCleanup } from "./project-storage-cleanup";
import { projectStorageCleanupStatus } from "../lib/project-storage-cleanup-status";

const reclaim = vi.hoisted(() => ({ fn: vi.fn<() => Promise<BlobReclaimResult>>() }));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  reclaimUnusedProjectStorage: reclaim.fn,
})));

afterEach(() => {
  cleanup();
  reclaim.fn.mockReset();
});

describe("ProjectStorageCleanup", () => {
  it("cleans only after it is confirmed, and says what it removed", async () => {
    reclaim.fn.mockResolvedValue({ status: "reclaimed", files: 3, bytes: 3 * 1024 * 1024, stopped: false });
    render(<ProjectStorageCleanup sourceControlOn={false} />);
    fireEvent.click(screen.getByTestId("clean-unused-project-storage"));
    expect(reclaim.fn).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("clean-unused-project-storage-run"));
    expect((await screen.findByTestId("clean-unused-project-storage-status")).textContent).toBe("Removed 3 files (3.0 MB).");
    expect(reclaim.fn).toHaveBeenCalledOnce();
  });

  it("is unavailable while source control manages the project's storage", () => {
    render(<ProjectStorageCleanup sourceControlOn />);
    expect((screen.getByTestId("clean-unused-project-storage") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("clean-unused-project-storage-status").textContent).toMatch(/Remove Unused Files/);
  });

  it.each([
    [{ status: "reclaimed", files: 0, bytes: 0, stopped: false }, "Nothing to remove."],
    [{ status: "reclaimed", files: 0, bytes: 0, stopped: true }, "The project changed meanwhile, so nothing was removed. Try again."],
    [{ status: "incomplete", unreadable: ["assets/A.hasset"] }, "Nothing was removed: an asset could not be read (assets/A.hasset)."],
  ] as const)("reports %j plainly", (result, text) => {
    expect(projectStorageCleanupStatus(result as BlobReclaimResult)).toBe(text);
  });
});
