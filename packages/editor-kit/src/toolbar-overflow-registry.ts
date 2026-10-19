import { createContext, useContext, useLayoutEffect } from "react";
import type { NestedMenuItem } from "./nested-menu";

interface OverflowEntry {
  priority: number;
  items: NestedMenuItem[];
}

/**
 * Which toolbar items are collapsed, and the menu forms of the items that can
 * be. Entries register from the controls themselves, so a control that owns
 * live state (a roster, a mode) keeps its menu form beside its toolbar form
 * without re-rendering the toolbar.
 */
export interface OverflowRegistry {
  entries: Map<string, OverflowEntry>;
  /** Collapsed ids in the toolbar's visual order. */
  collapsed: readonly string[];
  version: number;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
  set(id: string, priority: number, items: NestedMenuItem[]): void;
  remove(id: string): void;
  setCollapsed(ids: readonly string[]): void;
  /** Set by the toolbar root: item set or priorities changed, fit again. */
  onStructure: (() => void) | null;
}

export function createRegistry(): OverflowRegistry {
  const listeners = new Set<() => void>();
  const notify = () => {
    registry.version += 1;
    for (const listener of listeners) listener();
  };
  const structure = () => {
    registry.onStructure?.();
    notify();
  };
  const registry: OverflowRegistry = {
    entries: new Map(),
    collapsed: [],
    version: 0,
    onStructure: null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => registry.version,
    set(id, priority, items) {
      const previous = registry.entries.get(id);
      if (items.length === 0) {
        if (previous && registry.entries.delete(id)) structure();
        return;
      }
      registry.entries.set(id, { priority, items });
      if (!previous || previous.priority !== priority) structure();
      // Only the open overflow menu reads an entry's items.
      else if (registry.collapsed.includes(id)) notify();
    },
    remove(id) {
      if (registry.entries.delete(id)) structure();
    },
    setCollapsed(ids) {
      if (ids.length === registry.collapsed.length && ids.every((id, index) => id === registry.collapsed[index])) return;
      registry.collapsed = ids;
      notify();
    },
  };
  return registry;
}

export const RegistryContext = createContext<OverflowRegistry | null>(null);

/**
 * Registers `items` as the menu form of the control wrapped by `ToolbarOverflowItem id`.
 * Items share a collapse tier by `priority`: lower tiers collapse first and tied items
 * collapse together. With no items (or no priority) the control stays in place, for
 * example while it has nothing to show.
 */
export function useToolbarOverflowEntry(
  id: string,
  priority: number | undefined,
  items: NestedMenuItem[] | undefined,
): void {
  const registry = useContext(RegistryContext);
  useLayoutEffect(() => {
    if (priority === undefined || !items) return;
    registry?.set(id, priority, items);
  });
  useLayoutEffect(() => () => registry?.remove(id), [registry, id]);
}

