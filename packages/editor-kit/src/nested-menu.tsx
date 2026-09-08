import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { Separator } from "@babylonslate/ui/components/separator";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  clampOverlayMenuPosition,
  overlaySubmenuOrigin,
  type OverlaySafeAreaInsets,
} from "./clamp-overlay-menu";

export type NestedMenuItem =
  | {
      type?: "item";
      id: string;
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      variant?: "default" | "destructive";
      shortcut?: string;
      testId?: string;
    }
  | {
      type: "submenu";
      id: string;
      label: string;
      items: NestedMenuItem[];
      disabled?: boolean;
      testId?: string;
      contentTestId?: string;
    }
  | {
      type: "checkbox";
      id: string;
      label: string;
      checked: boolean;
      onCheckedChange: (next: boolean) => void;
      closeOnClick?: boolean;
      disabled?: boolean;
      testId?: string;
    }
  | {
      type: "radio-group";
      id: string;
      value: string;
      onValueChange: (value: string) => void;
      closeOnClick?: boolean;
      disabled?: boolean;
      items: Array<{
        id: string;
        label: string;
        value: string;
        disabled?: boolean;
        testId?: string;
      }>;
    }
  | { type: "separator"; id: string }
  | { type: "label"; id: string; label: string };

export interface NestedMenuProps {
  items: NestedMenuItem[];
  trigger?: ReactNode;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchor?: { x: number; y: number };
  size?: "chrome" | "touch";
  align?: "start" | "center" | "end";
  contentTestId?: string;
  contentClassName?: string;
}

function itemTestId(item: { id: string; testId?: string }): string {
  return item.testId ?? `context-menu-item-${item.id}`;
}

function NestedMenuItems({
  items,
  size,
}: {
  items: NestedMenuItem[];
  size: "chrome" | "touch";
}) {
  const itemClass =
    size === "touch" ? "min-h-[var(--touch-target,44px)]" : undefined;

  return (
    <DropdownMenuGroup>
      {items.map((item) => {
        if (item.type === "separator") {
          return <DropdownMenuSeparator key={item.id} />;
        }
        if (item.type === "label") {
          return (
            <DropdownMenuLabel key={item.id}>{item.label}</DropdownMenuLabel>
          );
        }
        if (item.type === "checkbox") {
          return (
            <DropdownMenuCheckboxItem
              key={item.id}
              checked={item.checked}
              disabled={item.disabled}
              closeOnClick={item.closeOnClick}
              className={itemClass}
              data-testid={itemTestId(item)}
              onCheckedChange={(checked) => item.onCheckedChange(checked)}
            >
              {item.label}
            </DropdownMenuCheckboxItem>
          );
        }
        if (item.type === "radio-group") {
          return (
            <DropdownMenuRadioGroup
              key={item.id}
              value={item.value}
              disabled={item.disabled}
              onValueChange={(value) => item.onValueChange(String(value))}
            >
              {item.items.map((option) => (
                <DropdownMenuRadioItem
                  key={option.id}
                  value={option.value}
                  disabled={option.disabled}
                  closeOnClick={item.closeOnClick}
                  className={itemClass}
                  data-testid={itemTestId(option)}
                >
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          );
        }
        if (item.type === "submenu") {
          return (
            <DropdownMenuSub key={item.id} disabled={item.disabled}>
              <DropdownMenuSubTrigger
                disabled={item.disabled}
                openOnHover={false}
                className={itemClass}
                data-testid={itemTestId(item)}
              >
                {item.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                className={
                  size === "touch"
                    ? "w-auto min-w-48"
                    : "w-max min-w-56 whitespace-nowrap"
                }
                data-testid={
                  item.contentTestId ?? `context-menu-sub-${item.id}`
                }
              >
                <NestedMenuItems items={item.items} size={size} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }
        return (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            variant={item.variant}
            className={itemClass}
            data-testid={itemTestId(item)}
            onClick={() => item.onSelect()}
          >
            {item.label}
            {item.shortcut ? (
              <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuGroup>
  );
}

function OverlayMenuItems({
  items,
  openSubmenuId,
  onOpenSubmenu,
  onClose,
  onBeforeSelect,
}: {
  items: NestedMenuItem[];
  openSubmenuId: string | null;
  onOpenSubmenu: (id: string | null) => void;
  onClose: () => void;
  onBeforeSelect: () => void;
}) {
  return (
    <>
      {items.map((item) => {
        if (item.type === "separator") {
          return <Separator key={item.id} />;
        }
        if (item.type === "label") {
          return (
            <div
              key={item.id}
              className="px-2 py-1 text-xs text-muted-foreground"
            >
              {item.label}
            </div>
          );
        }
        if (item.type === "checkbox") {
          return (
            <button
              key={item.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={item.checked}
              disabled={item.disabled}
              className="context-menu-item"
              data-testid={itemTestId(item)}
              onClick={() => {
                if (item.disabled) return;
                if (item.closeOnClick) onBeforeSelect();
                item.onCheckedChange(!item.checked);
                if (item.closeOnClick) onClose();
              }}
            >
              {item.label}
            </button>
          );
        }
        if (item.type === "radio-group") {
          return (
            <div key={item.id} role="group">
              {item.items.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.value === option.value}
                  disabled={item.disabled || option.disabled}
                  className="context-menu-item"
                  data-testid={itemTestId(option)}
                  onClick={() => {
                    if (item.disabled || option.disabled) return;
                    if (item.closeOnClick) onBeforeSelect();
                    item.onValueChange(option.value);
                    if (item.closeOnClick) onClose();
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          );
        }
        if (item.type === "submenu") {
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              aria-haspopup="menu"
              aria-expanded={openSubmenuId === item.id}
              className="context-menu-item"
              data-testid={itemTestId(item)}
              onClick={() => {
                if (item.disabled) return;
                onOpenSubmenu(openSubmenuId === item.id ? null : item.id);
              }}
            >
              {item.label}
              <ChevronRightIcon className="ml-auto" />
            </button>
          );
        }
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cn(
              "context-menu-item",
              item.variant === "destructive" && "text-destructive",
            )}
            data-testid={itemTestId(item)}
            onClick={() => {
              if (item.disabled) return;
              onBeforeSelect();
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </>
  );
}

function OverlayMenu({
  items,
  x,
  y,
  contentTestId,
  onClose,
  parentWidth,
  parentPanels,
  onBack,
  beforeSelect,
}: {
  items: NestedMenuItem[];
  x: number;
  y: number;
  contentTestId?: string;
  onClose: () => void;
  parentWidth?: number;
  parentPanels?: Set<HTMLElement>;
  onBack?: () => void;
  beforeSelect?: () => void;
}) {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [position, setPosition] = useState({ x, y });
  const panelRef = useRef<HTMLDivElement>(null);
  const ownedPanels = useRef(new Set<HTMLElement>());
  const returnFocus = useRef<Element | null>(null);
  const focusPanels = parentPanels ?? ownedPanels.current;
  const openSubmenu = items.find(
    (item) => item.type === "submenu" && item.id === openSubmenuId,
  );
  const [viewport, setViewport] = useState(readOverlayViewport);
  const prepareSelection =
    beforeSelect ??
    (() => {
      const invoker = returnFocus.current;
      // Dialogs opened by an action must capture the durable invoker, not a menu
      // item that disappears in the same render.
      if (invoker instanceof HTMLElement && invoker.isConnected)
        invoker.focus({ preventScroll: true });
    });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previousFocus = returnFocus.current ?? document.activeElement;
    returnFocus.current = previousFocus;
    focusPanels.add(panel);
    (enabledOverlayItems(panel)[0] ?? panel).focus({ preventScroll: true });
    return () => {
      const activeAtClose = document.activeElement;
      const ownedFocus = [...focusPanels].some((element) =>
        element.contains(activeAtClose),
      );
      focusPanels.delete(panel);
      if (
        parentPanels ||
        !(previousFocus instanceof HTMLElement) ||
        (!ownedFocus && activeAtClose !== document.body)
      )
        return;
      // A selected action may have opened a dialog or deliberately moved focus.
      // Let that destination win after the old menu nodes leave the document.
      queueMicrotask(() => {
        if (
          !focusPanels.has(panel) &&
          previousFocus.isConnected &&
          (document.activeElement === document.body ||
            document.activeElement === activeAtClose)
        ) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [focusPanels, parentPanels]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest("input, textarea, select, [contenteditable=true]") ||
      target.closest('[role="menu"]') !== event.currentTarget
    )
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      onClose();
      return;
    }
    if (
      event.key === "ArrowRight" &&
      target.getAttribute("aria-haspopup") === "menu"
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (target.getAttribute("aria-expanded") !== "true") target.click();
      return;
    }
    if (event.key === "ArrowLeft" && onBack) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
      return;
    }
    const items = enabledOverlayItems(event.currentTarget);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (index + 1) % items.length;
        break;
      case "ArrowUp":
        next = (index - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const refreshViewport = () => {
      const nextViewport = readOverlayViewport();
      setViewport((currentViewport) =>
        sameViewport(currentViewport, nextViewport)
          ? currentViewport
          : nextViewport,
      );
    };
    window.addEventListener("resize", refreshViewport);
    window.addEventListener("orientationchange", refreshViewport);
    window.visualViewport?.addEventListener("resize", refreshViewport);
    return () => {
      window.removeEventListener("resize", refreshViewport);
      window.removeEventListener("orientationchange", refreshViewport);
      window.visualViewport?.removeEventListener("resize", refreshViewport);
    };
  }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const rect = panel?.getBoundingClientRect();
    const width = rect?.width ?? 192;
    const height = rect?.height ?? 0;
    setPosition(
      clampOverlayMenuPosition({
        x,
        y,
        width,
        height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        margin: 8,
        insets: viewport.insets,
      }),
    );
  }, [x, y, items, viewport]);

  const submenuOrigin = openSubmenu
    ? overlaySubmenuOrigin({
        parentX: position.x,
        parentY: position.y,
        parentWidth:
          parentWidth ?? panelRef.current?.getBoundingClientRect().width ?? 192,
        submenuWidth: 192,
        viewportWidth: viewport.width,
        margin: 8,
        insets: viewport.insets,
      })
    : null;

  return (
    <>
      <div
        ref={panelRef}
        className="context-menu-panel"
        data-testid={contentTestId}
        style={{ left: position.x, top: position.y }}
        role="menu"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <OverlayMenuItems
          items={items}
          openSubmenuId={openSubmenuId}
          onOpenSubmenu={setOpenSubmenuId}
          onClose={onClose}
          onBeforeSelect={prepareSelection}
        />
      </div>
      {openSubmenu && openSubmenu.type === "submenu" && submenuOrigin ? (
        <OverlayMenu
          items={openSubmenu.items}
          x={submenuOrigin.x}
          y={submenuOrigin.y}
          parentWidth={192}
          parentPanels={focusPanels}
          beforeSelect={prepareSelection}
          onBack={() => {
            setOpenSubmenuId(null);
            panelRef.current
              ?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')
              ?.focus({ preventScroll: true });
          }}
          contentTestId={
            openSubmenu.contentTestId ?? `context-menu-sub-${openSubmenu.id}`
          }
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

function enabledOverlayItems(panel: HTMLElement): HTMLButtonElement[] {
  return [
    ...panel.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]'),
  ].filter((item) => !item.disabled);
}

function parseCssPixelToken(name: string): number {
  if (typeof document === "undefined") return 0;
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSafeAreaInsets(): OverlaySafeAreaInsets {
  return {
    top: parseCssPixelToken("--safe-top"),
    right: parseCssPixelToken("--safe-right"),
    bottom: parseCssPixelToken("--safe-bottom"),
    left: parseCssPixelToken("--safe-left"),
  };
}

type OverlayViewport = {
  width: number;
  height: number;
  insets: OverlaySafeAreaInsets;
};

function readOverlayViewport(): OverlayViewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    insets: readSafeAreaInsets(),
  };
}

function sameInsets(
  first: OverlaySafeAreaInsets,
  second: OverlaySafeAreaInsets,
): boolean {
  return (
    first.top === second.top &&
    first.right === second.right &&
    first.bottom === second.bottom &&
    first.left === second.left
  );
}

function sameViewport(
  first: OverlayViewport,
  second: OverlayViewport,
): boolean {
  return (
    first.width === second.width &&
    first.height === second.height &&
    sameInsets(first.insets, second.insets)
  );
}

export function NestedMenu({
  items,
  trigger,
  children,
  open,
  onOpenChange,
  anchor,
  size = "chrome",
  align = "start",
  contentTestId,
  contentClassName,
}: NestedMenuProps) {
  if (anchor) {
    if (open === false) return null;
    return (
      <OverlayMenu
        items={items}
        x={anchor.x}
        y={anchor.y}
        contentTestId={contentTestId}
        onClose={() => onOpenChange?.(false)}
      />
    );
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => onOpenChange?.(nextOpen)}
    >
      {isValidElement(trigger) ? (
        <DropdownMenuTrigger render={trigger as ReactElement}>
          {children}
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger>{trigger ?? children}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align={align}
        className={contentClassName}
        data-testid={contentTestId}
      >
        <NestedMenuItems items={items} size={size} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
