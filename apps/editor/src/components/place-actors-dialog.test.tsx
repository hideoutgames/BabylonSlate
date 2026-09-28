import { useState } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlaceActorsDialog } from "./place-actors-dialog";

/**
 * The Outliner closes this dialog itself after spawning, so the close never
 * goes through the dialog's own `onOpenChange`. Reopening must still start
 * from an empty catalog.
 */
function Harness({ onSelect }: { onSelect?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <PlaceActorsDialog
        open={open}
        onOpenChange={setOpen}
        onSelect={() => {
          onSelect?.();
          setOpen(false);
        }}
        projectItems={[]}
      />
    </>
  );
}

function searchValue(): string {
  return (screen.getByTestId("place-actors-catalog-search") as HTMLInputElement)
    .value;
}

afterEach(() => {
  cleanup();
});

describe("PlaceActorsDialog", () => {
  it("activates a searched actor with the keyboard and ignores composing keys", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.change(screen.getByTestId("place-actors-catalog-search"), {
      target: { value: "sphere" },
    });
    const row = screen.getByRole("button", { name: /sphere shapes/i });
    fireEvent.keyDown(row, { key: "Enter", isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("reopen"));
    expect(searchValue()).toBe("");
  });

  it("clears the search after the Outliner closes it on select", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("place-actors-catalog-search"), {
      target: { value: "sphere" },
    });
    expect(screen.queryByTestId("place-actors-item-shape-box")).toBeNull();

    fireEvent.click(screen.getByTestId("place-actors-item-shape-sphere"));
    fireEvent.click(screen.getByTestId("reopen"));

    expect(searchValue()).toBe("");
    expect(screen.getByTestId("place-actors-item-shape-box")).toBeTruthy();
  });

  it("clears the active category after the Outliner closes it on select", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("place-actors-catalog-category-Lights"));
    expect(screen.queryByTestId("place-actors-item-shape-box")).toBeNull();

    fireEvent.click(screen.getByTestId("place-actors-item-light-point"));
    fireEvent.click(screen.getByTestId("reopen"));

    expect(screen.getByTestId("place-actors-item-shape-box")).toBeTruthy();
  });

  it("opens on Featured cards and shows project Models as thumbnail cards apart from other assets", async () => {
    const onSelect = vi.fn();
    const model = {
      id: "asset-tree",
      title: "Tree",
      category: "Models",
      kind: { type: "asset" as const, name: "Tree", guid: "tree", assetType: "Model" },
    };
    const hero = {
      id: "asset-hero",
      title: "Hero",
      category: "Project",
      kind: { type: "asset" as const, name: "Hero", guid: "hero", assetType: "Class" },
    };
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => "blob:tree");
    URL.revokeObjectURL = vi.fn();
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    });
    const loadThumbnail = vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    render(
      <PlaceActorsDialog
        open
        onOpenChange={() => {}}
        onSelect={onSelect}
        projectItems={[model, hero]}
        loadThumbnail={loadThumbnail}
      />,
    );
    expect(screen.getByRole("group", { name: "Featured" })).toBeTruthy();
    expect(screen.queryByTestId("place-actors-item-light-spot")).toBeNull();
    expect(loadThumbnail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("place-actors-catalog-category-Models"));
    expect(screen.queryByTestId("place-actors-item-asset-hero")).toBeNull();
    await waitFor(() =>
      expect(
        screen
          .getByTestId("place-actors-item-asset-tree")
          .querySelector("img")
          ?.getAttribute("src"),
      ).toBe("blob:tree"),
    );
    expect(loadThumbnail).toHaveBeenCalledWith("tree");

    fireEvent.click(screen.getByTestId("place-actors-catalog-category-Project"));
    expect(screen.queryByTestId("place-actors-item-asset-tree")).toBeNull();
    fireEvent.click(screen.getByTestId("place-actors-item-asset-hero"));
    expect(onSelect).toHaveBeenCalledWith(hero);
  });

  it("filters Project assets by type from the Filter menu", async () => {
    const asset = (id: string, assetType: string, path: string) => ({
      id: `asset-${id}`,
      title: id,
      category: "Project",
      kind: { type: "asset" as const, name: id, guid: id, assetType, path },
    });
    render(
      <PlaceActorsDialog
        open
        onOpenChange={() => {}}
        onSelect={() => {}}
        projectItems={[
          asset("Hero", "Class", "assets/actors/Hero.class.babasset"),
          asset("Door", "Prefab", "assets/props/Door.prefab.babasset"),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("place-actors-catalog-category-Project"));
    expect(screen.getByTestId("place-actors-item-asset-Hero").textContent).toContain("assets/actors");

    fireEvent.click(screen.getByTestId("place-actors-project-filter"));
    fireEvent.click(await screen.findByTestId("place-actors-project-filter-Prefab"));
    await waitFor(() => expect(screen.queryByTestId("place-actors-item-asset-Hero")).toBeNull());
    expect(screen.getByTestId("place-actors-item-asset-Door")).toBeTruthy();
    expect(screen.getByTestId("place-actors-project-count").textContent).toBe("1 of 2 Assets");
    expect(screen.getByTestId("place-actors-project-filter").textContent).toBe("Filter (1)");
  });

  it("still clears the search when dismissed without selecting", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("place-actors-catalog-search"), {
      target: { value: "sphere" },
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("reopen"));

    expect(searchValue()).toBe("");
  });
});
