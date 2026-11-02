import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ok } from "@haptic/core";
import { PackagingDialog } from "./packaging-dialog";

const { exportGameArtifact, zipExportedGame } = vi.hoisted(() => ({
  exportGameArtifact: vi.fn(),
  zipExportedGame: vi.fn(),
}));

vi.mock("../context/document-context", async () => {
  const { createEmptyProject } = await import("@haptic/core");
  const projectDocument = createEmptyProject("Harbour Run");
  return (await import("../testing/document-context-mock")).documentContextMock(() => ({
    projectDocument,
    exportGameArtifact,
    zipExportedGame,
  }));
});

afterEach(() => {
  cleanup();
  exportGameArtifact.mockReset();
  zipExportedGame.mockReset();
  vi.restoreAllMocks();
});

function renderDialog(onOpenExportSettings = vi.fn()) {
  render(<PackagingDialog open onOpenChange={() => {}} onOpenExportSettings={onOpenExportSettings} />);
  return { onOpenExportSettings };
}

it("packages the project for the web and downloads the archive named after it", async () => {
  const artifact = { files: [] };
  exportGameArtifact.mockResolvedValue(ok(artifact));
  zipExportedGame.mockReturnValue(new Uint8Array([1, 2, 3]));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:game");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  renderDialog();
  expect(screen.getByTestId("packaging-target-web").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText(/Downloads Harbour_Run\.zip\./)).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByTestId("packaging-package"));
  });

  expect(exportGameArtifact).toHaveBeenCalledTimes(1);
  expect(exportGameArtifact.mock.calls[0]![0].projectSnapshot.metadata.name).toBe("Harbour Run");
  expect(zipExportedGame).toHaveBeenCalledWith(artifact);
  expect(downloads).toEqual(["Harbour_Run.zip"]);
  expect(screen.getByRole("status").textContent).toBe("Game package prepared. Check your downloads.");
});

it("explains a failed package and lets you try again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let reject!: (error: Error) => void;
  exportGameArtifact.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  renderDialog();
  fireEvent.click(screen.getByTestId("packaging-package"));
  expect(screen.getByTestId("packaging-package").textContent).toBe("Packaging…");
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(true);

  await act(async () => { reject(new Error("zip failed")); });

  expect(screen.getByTestId("packaging-error").textContent).toBe("Could not build the zip. Try again.");
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("status")).toBeNull();
});

it("opens the export settings that decide what a package includes", () => {
  const { onOpenExportSettings } = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Export Settings" }));
  expect(onOpenExportSettings).toHaveBeenCalledTimes(1);
  expect(exportGameArtifact).not.toHaveBeenCalled();
});
