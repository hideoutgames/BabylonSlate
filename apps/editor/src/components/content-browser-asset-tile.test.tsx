import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { IndexedAsset } from "@haptic/assets";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  resolveTypeVisual,
} from "@haptic/editor-kit";
import { dispatchPointerEvent } from "@haptic/editor-kit/test-support/pointer-events";
import { ContentBrowserAssetTile } from "./content-browser-asset-tile";
import { classParentLookup, visualForIndexedAsset } from "../lib/content-browser-helpers";

function asset(): IndexedAsset {
  return {
    rootId: "project",
    path: "assets/hero.hasset",
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [],
      guid: "hero-1",
      type: "Texture",
      name: "hero",
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [],
    },
  };
}

function renderTile(
  overrides: Partial<Parameters<typeof ContentBrowserAssetTile>[0]> = {},
) {
  const onOpen = vi.fn();
  const onSelect = vi.fn();
  const onLongPressMenu = vi.fn();
  const item = asset();
  const utils = render(
    <ContentBrowserAssetTile
      asset={item}
      selected={false}
      thumbnailUrl={null}
      typeVisual={resolveTypeVisual({ assetType: item.header.type })}
      onOpen={onOpen}
      onSelect={onSelect}
      onLongPressMenu={onLongPressMenu}
      {...overrides}
    />,
  );
  return {
    ...utils,
    onOpen,
    onSelect,
    onLongPressMenu,
    tile: screen.getByTestId("content-item-assets/hero.hasset"),
  };
}

describe("ContentBrowserAssetTile", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("labels a Class by its kind through project parents, and other assets by type", () => {
    const classAsset = (guid: string, name: string, parentClass: string): IndexedAsset => {
      const base = asset();
      return { ...base, path: `assets/${name}.class.hasset`, header: { ...base.header, guid, type: "Class", name, parentClass } };
    };
    const enemy = classAsset("enemy-1", "EnemyBase", "Actor");
    const goblin = classAsset("goblin-1", "Goblin", "EnemyBase");
    const rules = classAsset("rules-1", "GameRules", "Object");
    const parentOf = classParentLookup([enemy, goblin, rules]);
    const subtitle = (item: IndexedAsset) => {
      const { container } = render(
        <ContentBrowserAssetTile
          asset={item}
          selected={false}
          thumbnailUrl={null}
          typeVisual={visualForIndexedAsset(item, parentOf)}
          onOpen={vi.fn()}
          onSelect={vi.fn()}
          onLongPressMenu={vi.fn()}
        />,
      );
      const text = container.querySelector('[data-slot="card-description"]')?.textContent;
      cleanup();
      return text;
    };
    expect(subtitle(goblin)).toBe("Actor");
    expect(subtitle(rules)).toBe("Object");
    expect(subtitle(asset())).toBe("Texture");
  });

  it("opens the context menu after a stationary long press while the pointer is down", async () => {
    vi.useFakeTimers();
    const { tile, onLongPressMenu } = renderTile();
    dispatchPointerEvent(tile, "pointerdown", { clientX: 5, clientY: 5 });
    await act(async () => {
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onLongPressMenu).toHaveBeenCalledWith(5, 5);
  });

  it("does not open the context menu when the pointer moves before the delay", async () => {
    vi.useFakeTimers();
    const { tile, onLongPressMenu } = renderTile();
    dispatchPointerEvent(tile, "pointerdown", { clientX: 5, clientY: 5 });
    await act(async () => {
      dispatchPointerEvent(tile, "pointermove", {
        clientX: 5 + CONTEXT_MENU_MOVE_TOLERANCE_PX + 1,
        clientY: 5,
      });
      vi.advanceTimersByTime(CONTEXT_MENU_LONG_PRESS_MS);
    });
    expect(onLongPressMenu).not.toHaveBeenCalled();
  });

  it("opens the context menu on right-click", () => {
    const { tile, onLongPressMenu, onSelect } = renderTile();
    const notPrevented = fireEvent.contextMenu(tile, {
      clientX: 12,
      clientY: 18,
    });
    expect(notPrevented).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onLongPressMenu).toHaveBeenCalledWith(12, 18);
  });

  it("titles a dotted asset name in full", () => {
    const item = asset();
    item.header.name = "Player.Idle";
    const { tile } = renderTile({ asset: item });
    expect(tile.textContent).toContain("Player.Idle");
  });

  it("renames the file name inline in the title row, keeping the type line and a non-button host", () => {
    const item = asset();
    item.path = "assets/Hero.hasset";
    item.header.name = "Hero Texture";
    const onRenameDone = vi.fn();
    render(
      <ContentBrowserAssetTile
        asset={item}
        selected
        thumbnailUrl={null}
        typeVisual={resolveTypeVisual({ assetType: item.header.type })}
        onOpen={() => {}}
        onSelect={() => {}}
        onLongPressMenu={() => {}}
        renaming
        onRenameDone={onRenameDone}
      />,
    );
    const tile = screen.getByTestId(`content-item-${item.path}`);
    const field = screen.getByTestId(`content-item-rename-${item.path}`) as HTMLInputElement;
    expect(tile.tagName).toBe("DIV");
    expect(field.value).toBe("Hero");
    expect(document.activeElement).toBe(field);
    // Same 20px row as the title on every pointer, so the type line stays put.
    expect(field.className).toContain("h-5");
    expect(field.className).toContain("pointer-coarse:h-5");
    expect(field.className).not.toContain("pointer-coarse:h-9");
    expect(field.getAttribute("enterkeyhint")).toBe("done");
    expect(tile.textContent).toContain("Texture");
    fireEvent.change(field, { target: { value: "Champion" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onRenameDone).toHaveBeenCalledWith("Champion");
  });

  it("selects on click", () => {
    const { tile, onSelect } = renderTile();
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("skips the tap select when consumeSelectClick reports a paint or menu", () => {
    const { tile, onSelect } = renderTile({
      consumeSelectClick: () => true,
    });
    fireEvent.click(tile);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not exclusive-select on a non-primary click", () => {
    const { tile, onSelect } = renderTile();
    fireEvent.click(tile, { button: 2 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("is not an HTML5 drag source", () => {
    const { tile } = renderTile();
    expect(tile.getAttribute("draggable")).not.toBe("true");
    const setData = vi.fn();
    fireEvent.dragStart(tile, {
      dataTransfer: { setData, effectAllowed: "copyMove" },
    });
    expect(setData).not.toHaveBeenCalled();
  });

  it("badges a Texture as Encoding while its encode runs, though its file shows no state", () => {
    const { unmount } = renderTile();
    expect(screen.queryByTestId("texture-compression-hero-1")).toBeNull();
    unmount();
    renderTile({ encoding: true });
    expect(screen.getByTestId("texture-compression-hero-1").textContent).toBe("Encoding");
  });

  it("keeps the lock slot hidden when source control is off", () => {
    renderTile();
    const slot = document.querySelector("[data-lock-slot]");
    expect(slot).not.toBeNull();
    expect(slot?.classList.contains("hidden")).toBe(true);
    expect(slot?.getAttribute("data-lock-state")).toBeNull();
  });

  it("marks our lock with a filled lock badge named for us", () => {
    renderTile({ sourceControlEnabled: true, lockState: "mine" });
    const slot = document.querySelector<HTMLElement>("[data-lock-slot]");
    expect(slot?.classList.contains("hidden")).toBe(false);
    expect(slot?.getAttribute("data-lock-state")).toBe("mine");
    expect(slot?.querySelector("svg")?.classList.contains("lucide-lock")).toBe(true);
    expect(slot?.getAttribute("aria-label")).toBe("Locked By You");
  });

  it("marks someone else's lock with an outlined badge that names the holder", () => {
    renderTile({
      sourceControlEnabled: true,
      lockState: "theirs",
      lockOwnerName: "Bob",
    });
    const slot = document.querySelector<HTMLElement>("[data-lock-slot]");
    expect(slot?.getAttribute("data-lock-state")).toBe("theirs");
    expect(slot?.getAttribute("aria-label")).toBe("Locked By Bob");
    expect(slot?.getAttribute("title")).toBe("Locked By Bob");
    // A different glyph from our own lock, not only another colour.
    expect(slot?.querySelector("svg")?.classList.contains("lucide-user-lock")).toBe(true);
  });

  it("marks an asset added since the last commit with a plus, and a modified one with M", () => {
    const { unmount } = renderTile({ sourceControlEnabled: true, changeStatus: "added" });
    const added = screen.getByRole("img", { name: "Added" });
    expect(added.querySelector("svg")?.classList.contains("lucide-plus")).toBe(true);
    unmount();
    renderTile({ sourceControlEnabled: true, changeStatus: "modified" });
    expect(screen.getByRole("img", { name: "Modified" }).textContent).toBe("M");
  });

  it("shows no change marker for an unchanged asset", () => {
    renderTile({ sourceControlEnabled: true, changeStatus: null });
    expect(screen.queryByRole("img", { name: /Added|Modified/ })).toBeNull();
  });
});
