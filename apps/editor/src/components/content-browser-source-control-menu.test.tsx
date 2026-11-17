import { describe, expect, it, vi } from "vitest";
import type { ContextMenuItem } from "@haptic/editor-kit";
import type { FileLock } from "@haptic/source-control";
import type { ChangeRow } from "../lib/source-control-changes";
import { contentBrowserSourceControlMenu, type SourceControlMenuState } from "./content-browser-source-control-menu";

const FOREST = { path: "assets/Forest.scene.hasset", name: "Forest", type: "Scene" };
const ROCK = { path: "assets/Rock.texture.hasset", name: "Rock", type: "Texture" };
const CAVE = { path: "assets/Cave.scene.hasset", name: "Cave", type: "Scene" };

const lock = (path: string, ownerName: string, ours: boolean): FileLock => ({ id: `lock-${path}`, path, ownerName, lockedAt: "", ours });
const changed = (path: string, kind: ChangeRow["kind"]): ChangeRow => ({ id: path, name: path, folder: "Assets", kind, type: "Scene", paths: [path] });

function menuState({
  mode = "manual" as "off" | "manual" | "integrated",
  enabled = true,
  locks = [] as FileLock[],
  rows = [] as ChangeRow[],
  head = "c1" as string | null,
  syncActive = true,
  withActions = true,
} = {}) {
  const byPath = new Map(locks.map((entry) => [entry.path, entry]));
  const actions = { openDiff: vi.fn(), openHistory: vi.fn(), requestRevert: vi.fn() };
  const state: SourceControlMenuState = {
    sourceControl: {
      active: mode !== "off",
      mode,
      enabled,
      lockingUnsupported: false,
      lockStateForPath: (path) => (byPath.has(path) ? (byPath.get(path)!.ours ? "mine" : "theirs") : null),
      lockForPath: (path) => byPath.get(path),
    },
    sync: { active: syncActive, rows, head },
    actions: withActions ? actions : null,
    lock: vi.fn(),
    release: vi.fn(),
    forceUnlock: vi.fn(),
  };
  return { state, actions };
}

/** The submenu's entries as `label` (`label (disabled)`), separators as `---`. */
function entries(menu: ContextMenuItem | null): string[] {
  if (!menu || menu.type !== "submenu") throw new Error("Expected the Source Control submenu");
  return menu.items.map((item) => {
    if (item.type === "separator") return "---";
    if (item.type === "label") return `[${item.label}]`;
    if (item.type === "radio-group") return item.id;
    return `${item.label}${item.disabled ? " (disabled)" : ""}`;
  });
}

function select(menu: ContextMenuItem | null, id: string) {
  const item = menu?.type === "submenu" ? menu.items.find((entry) => entry.id === id) : undefined;
  if (!item || item.type === "separator" || item.type === "label" || item.type === "submenu" || item.type === "panel" || item.type === "checkbox" || item.type === "radio-group") {
    throw new Error(`No action ${id}`);
  }
  item.onSelect();
}

describe("contentBrowserSourceControlMenu", () => {
  it("is not offered while Source Control is Off", () => {
    expect(contentBrowserSourceControlMenu([FOREST], menuState({ mode: "off" }).state)).toBeNull();
  });

  it("offers Lock for an asset nobody holds, and only Lock and lock actions in Manual mode", () => {
    const { state } = menuState();
    const menu = contentBrowserSourceControlMenu([FOREST], state);
    expect(menu?.type === "submenu" && menu.label).toBe("Source Control");
    expect(entries(menu)).toEqual(["Lock"]);
    select(menu, "source-control-lock");
    expect(state.lock).toHaveBeenCalledWith([FOREST.path]);
  });

  it("starts with Locked By You over Release Lock for our lock", () => {
    const { state } = menuState({ locks: [lock(FOREST.path, "Ada", true)] });
    const menu = contentBrowserSourceControlMenu([FOREST], state);
    expect(entries(menu)).toEqual(["[Locked By You]", "---", "Release Lock"]);
    select(menu, "source-control-release-lock");
    expect(state.release).toHaveBeenCalledWith([FOREST.path]);
  });

  it("names someone else's lock and offers Force Unlock…, which asks first", () => {
    const theirs = lock(FOREST.path, "Bob", false);
    const { state } = menuState({ locks: [theirs] });
    const menu = contentBrowserSourceControlMenu([FOREST], state);
    expect(entries(menu)).toEqual(["[Locked By Bob]", "---", "Force Unlock…"]);
    select(menu, "source-control-force-unlock");
    expect(state.forceUnlock).toHaveBeenCalledWith(theirs);
  });

  it("disables lock actions while locks are not live (signed out)", () => {
    expect(entries(contentBrowserSourceControlMenu([FOREST], menuState({ enabled: false }).state))).toEqual(["Lock (disabled)"]);
  });

  it("locks the unheld and releases our own of several assets, with no holder line, Force Unlock or Integrated items", () => {
    const { state } = menuState({
      mode: "integrated",
      locks: [lock(ROCK.path, "Ada", true), lock(CAVE.path, "Bob", false)],
      rows: [changed(FOREST.path, "modified")],
    });
    const menu = contentBrowserSourceControlMenu([FOREST, ROCK, CAVE], state);
    expect(entries(menu)).toEqual(["Lock", "Release Lock"]);
    select(menu, "source-control-lock");
    expect(state.lock).toHaveBeenCalledWith([FOREST.path]);
    select(menu, "source-control-release-lock");
    expect(state.release).toHaveBeenCalledWith([ROCK.path]);
  });

  it("adds Show Changes, Show History and Revert… for a changed asset in Integrated mode", () => {
    const { state, actions } = menuState({ mode: "integrated", rows: [changed(FOREST.path, "added")] });
    const menu = contentBrowserSourceControlMenu([FOREST], state);
    expect(entries(menu)).toEqual(["Lock", "---", "Show Changes", "Show History", "Revert…"]);
    select(menu, "source-control-show-changes");
    expect(actions.openDiff).toHaveBeenCalledWith({ path: FOREST.path, name: "Forest", type: "Scene" });
    select(menu, "source-control-show-history");
    expect(actions.openHistory).toHaveBeenCalledWith(FOREST.path);
    select(menu, "source-control-revert");
    expect(actions.requestRevert).toHaveBeenCalledWith({ path: FOREST.path, name: "Forest", ref: { kind: "head" } });
  });

  it("disables Show Changes and Revert… for an unchanged asset, and Revert… before the first commit", () => {
    expect(entries(contentBrowserSourceControlMenu([FOREST], menuState({ mode: "integrated" }).state)))
      .toEqual(["Lock", "---", "Show Changes (disabled)", "Show History", "Revert… (disabled)"]);
    expect(entries(contentBrowserSourceControlMenu([FOREST], menuState({ mode: "integrated", rows: [changed(FOREST.path, "added")], head: null }).state)))
      .toEqual(["Lock", "---", "Show Changes", "Show History", "Revert… (disabled)"]);
  });

  it("disables the Integrated items while the sync is not running here", () => {
    expect(entries(contentBrowserSourceControlMenu([FOREST], menuState({ mode: "integrated", syncActive: false, rows: [changed(FOREST.path, "modified")] }).state)))
      .toEqual(["Lock", "---", "Show Changes (disabled)", "Show History (disabled)", "Revert… (disabled)"]);
  });

  it("leaves the Integrated items out without the editor's Source Control actions", () => {
    expect(entries(contentBrowserSourceControlMenu([FOREST], menuState({ mode: "integrated", withActions: false }).state))).toEqual(["Lock"]);
  });
});
