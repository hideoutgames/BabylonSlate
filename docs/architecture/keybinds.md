# Keybinds

Desktop keyboard shortcuts for editor commands. Buttons and menus stay the primary touch affordance; keybinds only add a desktop path and are shown as keycaps wherever the command appears.

## Pieces

| Piece | Location | Role |
| --- | --- | --- |
| Chord helpers | `@babylonslate/editor-kit` `keybinds.ts` | Parse, normalize, format, and match chords; `aria-keyshortcuts` and screen-reader text |
| `ShortcutKeys` | `@babylonslate/editor-kit` | Keycap group (`Kbd`) with Lucide glyphs for Command, Option, Control, Shift, Enter, Backspace, and arrows |
| Command catalog | `apps/editor/src/lib/editor-keybinds.ts` | `EDITOR_COMMANDS` with labels, categories, and default chords; override helpers |
| Dispatcher | `apps/editor/src/context/keybind-context.tsx` | `KeybindProvider`, `useKeybindCommand`, `useKeybindChord`, `useKeybindings` |

## Chords

- Canonical strings such as `Mod+Shift+Z`, `Alt+P`, `F2`, `Delete`. Modifier order is `Mod`, `Ctrl`, `Alt`, `Shift`.
- `Mod` is Command on Apple platforms and Control elsewhere. `Ctrl` is only distinct on Apple.
- Letters, digits, and punctuation match the physical key (`event.code`), so Option and Shift do not change the bound key.

## Default commands

| Category | Command | Default |
| --- | --- | --- |
| General | Save All, Undo, Redo | Mod+S; Mod+Z; Mod+Shift+Z or Mod+Y |
| General | Search Project, Toggle Focus, Engine Settings | Mod+K; Mod+Shift+F; Mod+, |
| General | Project Settings | Unassigned |
| Play | Play, Compile | Alt+P; F7 |
| Viewport | Move, Rotate, Scale Tool | 1, 2, 3 (W/A/S/D fly the camera) |
| Viewport | Frame Selection | F |
| Editing | Duplicate, Rename, Delete | Mod+D; F2; Delete or Backspace |

## Dispatch rules

- One window `keydown` listener. The newest enabled registration for the matched command runs and the event is `preventDefault`ed.
- Skipped while Play runs, during IME composition, with three or more pointers down, and while a modal dialog or alert dialog is open.
- Text fields and `SelectableText` keep native editing. Only commands marked for text input (Save All, Search Project, Engine Settings) fire there.
- Menus, listboxes, comboboxes, and selects keep their own key navigation.
- Held keys repeat only Undo and Redo.
- `scopeRef` limits a handler to a visible surface (the active viewport). `focusWithinRef` also requires keyboard focus inside it; the outliner and Content Browser use it so Delete, Duplicate, and Rename act on the focused panel's selection.
- Viewport fly keys ignore presses with Command, Control, or Option, so chords such as Mod+S never start flying.

## Display

- Tooltips show the label and `ShortcutKeys` (`IconActionButton` `shortcut`, `ActionFeedbackButton` `command`).
- `NestedMenu` items take `shortcut` and render it right-aligned; coarse-pointer context menus hide keycaps.
- Controls with a shortcut set `aria-keyshortcuts`; visual keycaps are decorative.

## Settings

Engine Settings → Editor → **Keybinds** lists commands by category. Selecting a shortcut records the next chord (lone modifiers wait, Escape cancels without closing the dialog, Tab leaves). Each row can be unassigned or reset; **Reset All** clears every override. Rows warn when a chord is shared with another command, and viewport tools warn on W/A/S/D because those fly the camera. Settings search matches command names.

## Storage

Overrides live in Engine Settings `keybinds` (`Record<commandId, chord[]>`). Only commands that differ from their defaults are stored, so later default changes still reach users who never customized them. An empty list unassigns a command. Unparseable chords are ignored; a malformed map falls back to `{}` without dropping other settings.
