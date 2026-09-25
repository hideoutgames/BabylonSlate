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
| General | Project Settings, Content Browser | Mod+Shift+,; Alt+B |
| Documents | Close Document, Close Open Tabs | Alt+W; Alt+Shift+W |
| Documents | Next Document, Previous Document | Alt+PageDown; Alt+PageUp |
| Play | Play, Compile | Alt+P; F7 |
| Viewport | Move, Rotate, Scale Tool | 1, 2, 3 (W/A/S/D fly the camera) |
| Viewport | Frame Selection | F |
| Viewport | Snap Grid, Show Grid, Drag Select | G; Shift+G; Q |
| Viewport | Show Collisions, Show Navmesh, Game Camera | Alt+C; Shift+N; Shift+C |
| Viewport | Switch 2D / 3D, Drop Selection | Alt+V; End |
| Editing | Duplicate, Rename, Delete | Mod+D; F2; Delete or Backspace |
| Editing | Search Panel, New Folder, Place Actors | Mod+F; Alt+Shift+N; Alt+A |
| Content Browser | New Asset, Import Assets, Show References | Alt+N; Alt+I; Alt+R |

## Dispatch rules

- One window `keydown` listener. The newest enabled registration for the matched command runs and the event is `preventDefault`ed.
- Skipped while Play runs, during IME composition, with three or more pointers down, and while a modal dialog or alert dialog is open.
- Text fields and `SelectableText` keep native editing. Only commands marked for text input (Save All, Search Project, Engine Settings, Search Panel) fire there.
- Menus, listboxes, comboboxes, and selects keep their own key navigation.
- Held keys repeat only Undo and Redo.
- `scopeRef` limits a handler to a visible surface (the active viewport). `focusWithinRef` also requires keyboard focus inside it; the outliner and Content Browser use it so Delete, Duplicate, and Rename act on the focused panel's selection.
- Search Panel focuses and selects the search field in the focused outliner or Content Browser. New Folder uses that panel's existing creation flow; Place Actors requires outliner focus. Asset creation/import require a writable Content Browser folder, and Show References uses the selected asset.
- Document navigation wraps through open documents, including the pinned Content Browser. Close commands use the same unsaved-change prompts as the menu; the Content Browser cannot be closed.
- Viewport toggles use the same state and persistence paths as their buttons. Hidden or disabled controls do not register executable shortcuts.
- Viewport fly keys ignore presses with Command, Control, or Option, so chords such as Mod+S never start flying.

## Display

- Tooltips show the label and `ShortcutKeys` (`IconActionButton` `shortcut`, `ActionFeedbackButton` `command`).
- `NestedMenu` actions and checkboxes take `shortcut` and render it right-aligned. Dropdown, document, and pointer-anchored menus hide keycaps on coarse pointers, keeping touch rows compact and tappable.
- Controls with a shortcut set `aria-keyshortcuts`; visual keycaps are decorative.

## Settings

Engine Settings → Editor → **Keybinds** lists commands by category. Selecting a shortcut records the next chord (lone modifiers wait, Escape cancels without closing the dialog, Tab leaves). Each row can be unassigned or reset; **Reset All** clears every override. Rows warn when a chord is shared with another command, and viewport tools warn on W/A/S/D because those fly the camera. Settings search matches command names.

## Storage

Overrides live in Engine Settings `keybinds` (`Record<commandId, chord[]>`). Only commands that differ from their defaults are stored, so later default changes still reach users who never customized them. An empty list unassigns a command. Unparseable chords are ignored; a malformed map falls back to `{}` without dropping other settings.
