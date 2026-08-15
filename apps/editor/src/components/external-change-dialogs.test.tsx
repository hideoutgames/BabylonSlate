import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExternalChangeDialogs } from "./external-change-dialogs";

describe("ExternalChangeDialogs", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers Reload Project when many files or project.json changed", () => {
    const onReloadProject = vi.fn();
    render(
      <ExternalChangeDialogs
        prompt={{
          kind: "reload-project",
          changedPaths: ["assets/a.babasset"],
          dirtyChangedPaths: [],
          cleanChangedPaths: [],
        }}
        onReloadProject={onReloadProject}
        onReloadDocs={vi.fn()}
        onKeepEdits={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("external-change-reload-project")).toBeTruthy();
    fireEvent.click(screen.getByTestId("external-change-reload-project-confirm"));
    expect(onReloadProject).toHaveBeenCalled();
  });

  it("warns dirty open documents with Keep Edits versus Reload From Disk", () => {
    const onKeepEdits = vi.fn();
    const onReloadDocs = vi.fn();
    render(
      <ExternalChangeDialogs
        prompt={{
          kind: "dirty-disk",
          changedPaths: ["assets/a.babasset"],
          dirtyChangedPaths: ["assets/a.babasset"],
          cleanChangedPaths: [],
        }}
        onReloadProject={vi.fn()}
        onReloadDocs={onReloadDocs}
        onKeepEdits={onKeepEdits}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("external-change-dirty-disk")).toBeTruthy();
    fireEvent.click(screen.getByTestId("external-change-keep-edits"));
    expect(onKeepEdits).toHaveBeenCalled();
  });
});
