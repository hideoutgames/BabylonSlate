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
  chordStartsWith,
  isApplePlatform,
  keepsNativeEditing,
  type KeyChord,
} from "@haptic/editor-kit";
import { GraphKeybindsContext, type GraphKeybinds } from "@haptic/graph-ui";
import {
  editorCommand,
  KEY_SEQUENCE_TIMEOUT_MS,
  resolveKeybinds,
  type EditorCommandDefinition,
  type EditorCommandId,
  type ResolvedKeybinds,
} from "../lib/editor-keybinds";
import { useAppSettings } from "./app-settings-context";

interface Registration {
  run: () => void;
  enabled?: () => boolean;
  /** Runs while a modal is open (the modal is this command's own surface). */
  allowInModal?: boolean;
}

interface KeybindContextValue {
  bindings: ResolvedKeybinds;
  register: (commandId: EditorCommandId, registration: RefObject<Registration>) => () => void;
}

const EMPTY_BINDINGS = resolveKeybinds();

const KeybindContext = createContext<KeybindContextValue | null>(null);

/**
 * Open modal popups: DialogContent and modal SheetContent set `aria-modal`
 * (Base UI does not), alert dialogs carry their own role. A popup in its exit
 * animation is `data-closed` and no longer swallows commands.
 */
const MODAL_SELECTOR =
  '[role="dialog"][aria-modal="true"]:not([data-closed]), [role="alertdialog"]:not([data-closed])';

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
    // Earlier steps of a multi-step shortcut waiting for the next one.
    let pending: KeyChord | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const clearPending = () => {
      pending = null;
      clearTimeout(pendingTimer);
    };
    const onPointerDown = (event: PointerEvent) => pointers.add(event.pointerId);
    const onPointerUp = (event: PointerEvent) => pointers.delete(event.pointerId);
    /** The newest registration that may run now, if any. */
    const runnable = (commandId: EditorCommandId) => {
      const modal = modalOpen();
      const handlers = registry.current.get(commandId) ?? [];
      for (let index = handlers.length - 1; index >= 0; index -= 1) {
        const registration = handlers[index]!.current;
        if (modal && !registration.allowInModal) continue;
        if (registration.enabled && !registration.enabled()) continue;
        return registration;
      }
      return undefined;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const pressed = chordFromEvent(event, apple);
      if (!pressed) return;
      // A held step neither advances nor abandons its shortcut.
      if (pending && event.repeat) {
        event.preventDefault();
        return;
      }
      const prefix = pending;
      clearPending();
      // A step that continues no shortcut is handled as a fresh press.
      const candidates = prefix ? [`${prefix} ${pressed}`, pressed] : [pressed];
      // Nothing to save, a modal, or Play must not fall through to the browser.
      for (const [commandId, chords] of state.current.bindings) {
        if (candidates.some((chord) => chords.includes(chord)) && editorCommand(commandId)?.blocksBrowserDefault) event.preventDefault();
      }
      if (state.current.suspended) return;
      // A three-finger viewport pan must not fire keyboard history.
      if (pointers.size >= 3) return;
      const typing = keepsNativeEditing(event.target);
      const allowed = (command: EditorCommandDefinition, chord: KeyChord) => {
        if (event.repeat && !command.repeat) return false;
        if (typing) return Boolean(command.allowInTextInput) && chordHasCommandModifier(chord);
        return !blockedTarget(event.target);
      };
      for (const chord of candidates) {
        for (const [commandId, chords] of state.current.bindings) {
          const command = editorCommand(commandId);
          if (!command || !chords.some((bound) => chordStartsWith(bound, chord) && allowed(command, bound))) continue;
          if (!runnable(commandId)) continue;
          event.preventDefault();
          pending = chord;
          pendingTimer = setTimeout(clearPending, KEY_SEQUENCE_TIMEOUT_MS);
          return;
        }
        for (const [commandId, chords] of state.current.bindings) {
          if (!chords.includes(chord)) continue;
          const command = editorCommand(commandId);
          if (!command || !allowed(command, chord)) continue;
          const registration = runnable(commandId);
          if (!registration) continue;
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
    window.addEventListener("blur", clearPending);
    return () => {
      clearPending();
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", clearPending);
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
  // Graph canvases own their Copy, Paste, Duplicate and Delete keys, so they
  // read the same bindings the Outliner and Content Browser register. Toggle
  // Breakpoint is the canvas's own, so it works while a Simulation runs.
  const graphKeybinds = useMemo(
    (): GraphKeybinds => ({
      copy: bindings.get("edit.copy") ?? [],
      paste: bindings.get("edit.paste") ?? [],
      duplicate: bindings.get("edit.duplicate") ?? [],
      delete: bindings.get("edit.delete") ?? [],
      toggleBreakpoint: bindings.get("graph.toggleBreakpoint") ?? [],
    }),
    [bindings],
  );

  return (
    <KeybindContext.Provider value={value}>
      <GraphKeybindsContext.Provider value={graphKeybinds}>
        {children}
      </GraphKeybindsContext.Provider>
    </KeybindContext.Provider>
  );
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
 * An open modal suspends every command unless its registration sets
 * `allowInModal` (a toggle that closes its own modal).
 */
export function useKeybindCommand(
  commandId: EditorCommandId | undefined,
  run: () => void,
  options: {
    enabled?: boolean | (() => boolean);
    scopeRef?: RefObject<Element | null>;
    focusWithinRef?: RefObject<Element | null>;
    allowInModal?: boolean;
  } = {},
): void {
  const context = useContext(KeybindContext);
  const { enabled = true, scopeRef, focusWithinRef, allowInModal } = options;
  const registration = useRef<Registration>({ run });
  registration.current = {
    run,
    allowInModal,
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
