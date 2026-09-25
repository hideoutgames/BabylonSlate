import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  chordFromEvent,
  chordHasCommandModifier,
  isApplePlatform,
  keepsNativeEditing,
  type KeyChord,
} from "@babylonslate/editor-kit";
import {
  editorCommand,
  resolveKeybinds,
  type EditorCommandId,
  type ResolvedKeybinds,
} from "../lib/editor-keybinds";
import { useAppSettings } from "./app-settings-context";

interface Registration {
  run: () => void;
  enabled?: () => boolean;
}

interface KeybindContextValue {
  bindings: ResolvedKeybinds;
  register: (commandId: EditorCommandId, registration: RefObject<Registration>) => () => void;
}

const EMPTY_BINDINGS = resolveKeybinds();

const KeybindContext = createContext<KeybindContextValue | null>(null);

const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"]';

/** Menus, pickers, and selects keep their own arrow/letter navigation. */
function blockedTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('select, [role="menu"], [role="listbox"], [role="combobox"]') !== null
  );
}

function modalOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(MODAL_SELECTOR) !== null;
}

export function KeybindProvider({
  children,
  suspended = false,
}: {
  children: ReactNode;
  /** Play sessions own the keyboard. */
  suspended?: boolean;
}) {
  const { settings } = useAppSettings();
  const bindings = useMemo(
    () => resolveKeybinds(settings.keybinds),
    [settings.keybinds],
  );
  const registry = useRef(new Map<EditorCommandId, RefObject<Registration>[]>());
  const state = useRef({ bindings, suspended });
  state.current = { bindings, suspended };

  useEffect(() => {
    const apple = isApplePlatform();
    const pointers = new Set<number>();
    const onPointerDown = (event: PointerEvent) => pointers.add(event.pointerId);
    const onPointerUp = (event: PointerEvent) => pointers.delete(event.pointerId);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || state.current.suspended) return;
      // A three-finger viewport pan must not fire keyboard history.
      if (pointers.size >= 3) return;
      const chord = chordFromEvent(event, apple);
      if (!chord) return;
      const typing = keepsNativeEditing(event.target);
      for (const [commandId, chords] of state.current.bindings) {
        if (!chords.includes(chord)) continue;
        const command = editorCommand(commandId);
        if (!command) continue;
        if (event.repeat && !command.repeat) continue;
        if (typing) {
          if (!command.allowInTextInput || !chordHasCommandModifier(chord)) continue;
        } else if (blockedTarget(event.target)) {
          continue;
        }
        if (modalOpen()) continue;
        const handlers = registry.current.get(commandId) ?? [];
        for (let index = handlers.length - 1; index >= 0; index -= 1) {
          const registration = handlers[index]!.current;
          if (registration.enabled && !registration.enabled()) continue;
          event.preventDefault();
          registration.run();
          return;
        }
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const register = useCallback<KeybindContextValue["register"]>(
    (commandId, registration) => {
      const list = registry.current.get(commandId) ?? [];
      registry.current.set(commandId, [...list, registration]);
      return () => {
        const current = registry.current.get(commandId) ?? [];
        registry.current.set(
          commandId,
          current.filter((entry) => entry !== registration),
        );
      };
    },
    [],
  );
  const value = useMemo(() => ({ bindings, register }), [bindings, register]);

  return <KeybindContext.Provider value={value}>{children}</KeybindContext.Provider>;
}

/** The primary chord shown in tooltips and menus, if the command is bound. */
export function useKeybindChord(
  commandId: EditorCommandId | undefined,
): KeyChord | undefined {
  const bindings = useContext(KeybindContext)?.bindings ?? EMPTY_BINDINGS;
  return commandId ? bindings.get(commandId)?.[0] : undefined;
}

export function useKeybindings(): ResolvedKeybinds {
  return useContext(KeybindContext)?.bindings ?? EMPTY_BINDINGS;
}

function visible(element: Element | null | undefined): boolean {
  if (!element?.isConnected) return false;
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return check ? check.call(element) : true;
}

/**
 * Run `run` when the command's chord is pressed. The newest enabled
 * registration wins; `scopeRef` limits a handler to a visible surface so
 * hidden documents do not react, and `focusWithinRef` additionally requires
 * keyboard focus inside that surface (used by selection-destructive edits).
 */
export function useKeybindCommand(
  commandId: EditorCommandId | undefined,
  run: () => void,
  options: {
    enabled?: boolean | (() => boolean);
    scopeRef?: RefObject<Element | null>;
    focusWithinRef?: RefObject<Element | null>;
  } = {},
): void {
  const context = useContext(KeybindContext);
  const { enabled = true, scopeRef, focusWithinRef } = options;
  const registration = useRef<Registration>({ run });
  registration.current = {
    run,
    enabled: () =>
      (typeof enabled === "function" ? enabled() : enabled) &&
      (!scopeRef || visible(scopeRef.current)) &&
      (!focusWithinRef ||
        (visible(focusWithinRef.current) &&
          focusWithinRef.current!.contains(document.activeElement))),
  };
  const register = context?.register;
  useEffect(
    () => (commandId ? register?.(commandId, registration) : undefined),
    [register, commandId],
  );
}
