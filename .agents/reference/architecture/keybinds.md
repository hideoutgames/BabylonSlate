# Keybinds

Desktop keyboard shortcuts for Haptic editor commands: chord format, catalog, dispatch rules, display and storage.

## Product decisions

- Buttons and menus stay the primary (touch) affordance. Keybinds only add a desktop path; every command keeps a visible control.
- Shortcuts are shown as keycaps wherever the command appears and hidden on coarse pointers.
- W/A/S/D fly the viewport camera, so viewport tools default to 1 / 2 / 3; settings warn when a tool is bound to W/A/S/D.

## Ownership

| Piece | Source |
| --- | --- |
| Chord parse / normalize / format / match, `aria-keyshortcuts` text | [`packages/editor-kit/src/keybinds.ts`](../../../packages/editor-kit/src/keybinds.ts) |
| `ShortcutKeys` keycap group (`Kbd` + Lucide modifier glyphs) | [`packages/editor-kit/src/shortcut-keys.tsx`](../../../packages/editor-kit/src/shortcut-keys.tsx) |
| Command catalog `EDITOR_COMMANDS` (ids, labels, categories, default chords, flags) and override helpers | [`apps/editor/src/lib/editor-keybinds.ts`](../../../apps/editor/src/lib/editor-keybinds.ts) |
| Dispatcher: `KeybindProvider`, `useKeybindCommand`, `useKeybindChord`, `useKeybindings` | [`apps/editor/src/context/keybind-context.tsx`](../../../apps/editor/src/context/keybind-context.tsx) |

The default chord table is the catalog itself; read `EDITOR_COMMANDS` rather than duplicating it.

## Chord format

- Canonical strings such as `Mod+Shift+Z`, `Alt+P`, `F2`, `Delete`. Modifier order: `Mod`, `Ctrl`, `Alt`, `Shift`.
- `Mod` is Command on Apple platforms and Control elsewhere; `Ctrl` is distinct only on Apple.
- Letters, digits and punctuation match the physical key (`event.code`), so Option/Shift do not change the bound key.

## Adding a command

1. Add an entry to `EDITOR_COMMANDS` with Title Case label, category and `defaultChords`.
2. Set `allowInTextInput` only for commands that must fire inside text fields (today: Save All, Search Project, Engine Settings, Search Panel), `repeat` only for Undo/Redo, `blocksBrowserDefault` only where the browser action must always be suppressed (Save All).
3. Register the handler with `useKeybindCommand` next to the control that performs the same action, reusing its state and persistence path. Hidden or disabled controls must not register executable shortcuts.
4. Pass the command to the control (`IconActionButton` `shortcut`, `ActionFeedbackButton` `command`, `NestedMenu` item `shortcut`) so tooltips and menus show keycaps and set `aria-keyshortcuts`.

## Dispatch rules

- One window `keydown` listener; the newest enabled registration for the matched command runs and the event is `preventDefault`ed.
- Skipped while Play runs, during IME composition, with three or more pointers down, and while a modal popup is open: `DialogContent` and modal `SheetContent` set `aria-modal` (Base UI does not), alert dialogs carry `role="alertdialog"`, and a popup in its exit animation (`data-closed`) no longer counts. A registration with `allowInModal` still runs (Search Project closes its own dialog); nonmodal popups (the Play console) never block. Save All's chord still suppresses the browser Save Page.
- Text fields and `SelectableText` keep native editing. Menus, listboxes, comboboxes and selects keep their own key navigation.
- `scopeRef` limits a handler to a visible surface (the active viewport). `focusWithinRef` also requires focus inside it; Outliner and Content Browser use it so Delete, Duplicate and Rename act on the focused panel.
- Viewport fly keys ignore presses with Command, Control or Option so `Mod+S` never starts flying.
- Graph canvases (`GraphEditor`) own their Copy, Paste, Duplicate and Delete keys instead of registering with the dispatcher, because `graph-ui` cannot import the app. `KeybindProvider` supplies `edit.copy`, `edit.paste`, `edit.duplicate` and `edit.delete` through `GraphKeybindsContext`, so Keybinds settings rebind graph keys and the node menu shows them; a graph outside the editor uses the defaults. A graph reacts only after its last pointer press or focus landed inside it (the arming survives host re-renders), never when hidden, read-only or targeted at a text field, menu, listbox or foreign dialog. Protected nodes stay; a host that hides the toolbar's Copy and Paste has no keys for them, and `deleteKeyCode={null}` turns key deletion off. Each key calls `preventDefault` only when the graph handled it; Duplicate always claims its chord while engaged so the browser's bookmark shortcut never opens.
- Document navigation wraps through open documents including the pinned Content Browser, which cannot be closed. Close commands use the normal unsaved-change prompts.

## Display

- Tooltips show the label plus `ShortcutKeys`; visual keycaps are decorative, `aria-keyshortcuts` carries the semantics.
- Dropdown, document and pointer-anchored menus hide keycaps on coarse pointers.

## Settings and storage

- Engine Settings → Editor → **Keybinds** lists commands by category; recording ignores lone modifiers, Escape cancels, Tab leaves. Rows can be unassigned or reset; **Reset All** clears every override. Shared chords show a warning.
- Engine Settings `keybinds` is `Record<commandId, chord[]>` holding only commands that differ from defaults, so later default changes still reach users who never customized them. An empty list unassigns. Unparseable chords are ignored; a malformed map falls back to `{}` without dropping other settings.
