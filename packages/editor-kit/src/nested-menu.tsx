import {
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
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
                data-testid={item.contentTestId ?? `context-menu-sub-${item.id}`}
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
}: {
  items: NestedMenuItem[];
  openSubmenuId: string | null;
  onOpenSubmenu: (id: string | null) => void;
  onClose: () => void;
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
}: {
  items: NestedMenuItem[];
  x: number;
  y: number;
  contentTestId?: string;
  onClose: () => void;
  parentWidth?: number;
}) {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [position, setPosition] = useState({ x, y });
  const panelRef = useRef<HTMLDivElement>(null);
  const openSubmenu = items.find(
    (item) => item.type === "submenu" && item.id === openSubmenuId,
  );

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
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
      }),
    );
  }, [x, y, items]);

  const submenuOrigin = openSubmenu
    ? overlaySubmenuOrigin({
        parentX: position.x,
        parentY: position.y,
        parentWidth: parentWidth ?? panelRef.current?.getBoundingClientRect().width ?? 192,
        submenuWidth: 192,
        viewportWidth: window.innerWidth,
        margin: 8,
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
      >
        <OverlayMenuItems
          items={items}
          openSubmenuId={openSubmenuId}
          onOpenSubmenu={setOpenSubmenuId}
          onClose={onClose}
        />
      </div>
      {openSubmenu && openSubmenu.type === "submenu" && submenuOrigin ? (
        <OverlayMenu
          items={openSubmenu.items}
          x={submenuOrigin.x}
          y={submenuOrigin.y}
          parentWidth={192}
          contentTestId={
            openSubmenu.contentTestId ?? `context-menu-sub-${openSubmenu.id}`
          }
          onClose={onClose}
        />
      ) : null}
    </>
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
