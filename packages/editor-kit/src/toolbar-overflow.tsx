import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { EllipsisVerticalIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { NestedMenu, type NestedMenuItem } from "./nested-menu";

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
interface OverflowRegistry {
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

function createRegistry(): OverflowRegistry {
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

const RegistryContext = createContext<OverflowRegistry | null>(null);

const OVER_TOLERANCE_PX = 1;

function overflowsWidth(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + OVER_TOLERANCE_PX;
}

/**
 * Collapses toolbar items, lowest priority tier first, until the bar and every track fit.
 * Every pass starts from the full toolbar, so the result depends only on the
 * widths now: a wider toolbar brings items back.
 */
function fitToolbar(root: HTMLElement, registry: OverflowRegistry): void {
  const wrappers = Array.from(root.querySelectorAll<HTMLElement>("[data-overflow-id]"));
  const trigger = root.querySelector<HTMLElement>("[data-overflow-trigger]");
  for (const wrapper of wrappers) wrapper.style.display = "";
  if (trigger) trigger.style.display = "none";
  const tracks = Array.from(root.querySelectorAll<HTMLElement>("[data-overflow-track]"));
  const priorityOf = (wrapper: HTMLElement) => registry.entries.get(wrapper.dataset.overflowId ?? "")?.priority;
  const tiers = [
    ...new Set(
      wrappers.map(priorityOf).filter((priority): priority is number => priority !== undefined),
    ),
  ].sort((a, b) => a - b);
  const hidden = new Set<HTMLElement>();
  for (const tier of tiers) {
    // The tracks share the bar's width, so an item in any track may free room for the one that overflows.
    if (!overflowsWidth(root) && !tracks.some(overflowsWidth)) break;
    for (const wrapper of wrappers) {
      if (priorityOf(wrapper) !== tier) continue;
      wrapper.style.display = "none";
      hidden.add(wrapper);
    }
    if (hidden.size > 0 && trigger) trigger.style.display = "";
  }
  registry.setCollapsed(
    wrappers.filter((wrapper) => hidden.has(wrapper)).map((wrapper) => wrapper.dataset.overflowId ?? ""),
  );
}

/**
 * A toolbar whose lower-priority items collapse into a trailing "More Actions" menu
 * when the bar is too narrow, measured from the real layout rather than a breakpoint.
 *
 * Lay the bar out as `ToolbarOverflowTrack` regions (flex or grid cells whose content
 * must not overflow), wrap each collapsible control in `ToolbarOverflowItem`, register
 * its menu form with `useToolbarOverflowEntry`, and place one `ToolbarOverflowMenu`.
 * A control without an entry never collapses.
 */
export function ToolbarOverflow({ className, children, ...props }: ComponentProps<"div">) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [registry] = useState(createRegistry);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observed = new Set<Element>();
    let frame = 0;
    let queued = false;
    // Content edits and swaps (a phone layout, a label) fit in a microtask, before paint and
    // after React has finished the commit that caused them.
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (root.isConnected) fit();
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(fit);
          });
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    // Controls that mount later join the observed set, so their size changes re-fit the bar.
    const syncObserved = () => {
      if (!resizeObserver) return;
      const current = new Set<Element>([root, ...root.querySelectorAll("[data-overflow-track]")]);
      for (const wrapper of root.querySelectorAll("[data-overflow-id]")) {
        if (wrapper.firstElementChild) current.add(wrapper.firstElementChild);
      }
      for (const element of observed) {
        if (current.has(element)) continue;
        resizeObserver.unobserve(element);
        observed.delete(element);
      }
      for (const element of current) {
        if (observed.has(element)) continue;
        resizeObserver.observe(element);
        observed.add(element);
      }
    };
    function fit() {
      fitToolbar(root!, registry);
      syncObserved();
    }
    registry.onStructure = schedule;
    mutationObserver?.observe(root, { childList: true, subtree: true, characterData: true });
    fit();
    // The window's own resize runs before observers, so the bar rarely paints overlapped.
    window.addEventListener("resize", fit);
    return () => {
      registry.onStructure = null;
      window.removeEventListener("resize", fit);
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [registry]);

  return (
    <RegistryContext.Provider value={registry}>
      <div ref={rootRef} className={className} {...props}>
        {children}
      </div>
    </RegistryContext.Provider>
  );
}

/** A region of the bar whose content must fit its own width. */
export function ToolbarOverflowTrack(props: ComponentProps<"div">) {
  return <div data-overflow-track="" {...props} />;
}

/**
 * Marks one control as collapsible. It adds no box (`display: contents`), so the control
 * lays out exactly as without it, and while collapsed it is not displayed.
 *
 * Pass `priority` and `items` to give the control its menu form here, or leave them out
 * when the control registers it itself with `useToolbarOverflowEntry` (it owns live state).
 */
export function ToolbarOverflowItem({
  id,
  priority,
  items,
  children,
}: {
  id: string;
  priority?: number;
  items?: NestedMenuItem[];
  children: ReactNode;
}) {
  useToolbarOverflowEntry(id, priority, items);
  return (
    <span data-overflow-id={id} className="contents">
      {children}
    </span>
  );
}

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

/** The "More Actions" button and menu: the collapsed items, with their labels, shortcuts and disabled states. */
export function ToolbarOverflowMenu({
  label = "More Actions",
  touch = false,
  variant = "outline",
  size = "icon-sm",
  ...props
}: {
  label?: string;
  /** Touch-sized menu rows. */
  touch?: boolean;
} & Omit<ComponentProps<typeof Button>, "children" | "aria-label">) {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error("ToolbarOverflowMenu must be inside ToolbarOverflow");
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  const items = registry.collapsed.flatMap((id) => registry.entries.get(id)?.items ?? []);
  return (
    // Shown by the fit pass only while something is collapsed.
    <span data-overflow-trigger="" className="contents">
      <NestedMenu
        items={items}
        align="end"
        size={touch ? "touch" : "chrome"}
        contentTestId="toolbar-overflow-menu-content"
        trigger={<Button variant={variant} size={size} aria-label={label} {...props} />}
      >
        <EllipsisVerticalIcon />
      </NestedMenu>
    </span>
  );
}
