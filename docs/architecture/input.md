# Input mappings (P6)

Mapping model and resolver contract (engineplan §11.1). Raw capture landed in P4; P6 adds the pure mapping layer and Project Settings authoring.

## Mapping model (`@babylonslate/input`)

| Type | Fields |
| --- | --- |
| `ActionMapping` | `name`, `bindings[]` |
| `AxisMapping` | `name`, `kind` (`"1d"` \| `"2d"`), `bindings[]` |

Each **binding** targets a device (`key`, `mouseButton`, `pointer`, `gamepadButton`, `gamepadAxis`, `touch`) plus a device-specific `code`. Optional `modifiers` (shift/ctrl/alt/meta). Bindable codes and labels live in `bindingCodesForDevice()` / `bindingCodeLabel()` (`packages/input/src/binding-catalog.ts`) so the Project Settings picker and stored-binding labels stay in sync.

**Axis bindings** additionally carry per-binding tuning:

| Field | Role |
| --- | --- |
| `deadZone` | Stick dead zone with remapped live range |
| `scale` | Output multiplier |
| `invert` | Flip sign |
| `sensitivity` | Extra multiplier (e.g. look axes) |
| `component` | `"x"` \| `"y"` for `kind: "2d"` axes |
| `digitalValue` | Constant while a digital binding is held |

`InputMappings` = `{ actions[], axes[] }`. `normalizeInputMappings()` coerces unknown `project.json` payloads and **drops empty `code`s** so Play never treats a blank mouse/pointer draft as button 0. Project Settings authoring passes `{ allowIncomplete: true }` so device switches and Add Binding keep `{ device, code: "" }` rows until a control is picked. `createDefaultInputMappings()` supplies Jump / Confirm / Move / Look defaults. Default **Move** includes keyboard, gamepad stick, touch joystick (`joystick-x` / `joystick-y`), and TouchDPad (`dpad-x` / `dpad-y`) so an on-screen stick, d-pad, and a gamepad drive the same `GetAxis2D("Move")` with no script change. Default **Jump** includes Space, gamepad Face Button Down (`0:0`), and touch control id `Jump` (Play overlay virtual stick / d-pad). Default Confirm → `0:1` (Face Button Right) so both actions do not fire from one button.

Gamepad picker labels are layout-agnostic Standard Gamepad names (Face Button Down/Right/Left/Up, bumpers, triggers, Left/Right Stick Click, D-Pad, Home). Stored codes stay `padIndex:buttonIndex`. Closed bindings stay pad-qualified (`Gamepad 1 Face Button Down`); picker rows show the button name under a `Gamepad N` group.

## InputResolver

Stateful fold of `RawInputEvent[]` → per-tick snapshot:

```ts
interface ResolvedInputTick {
  actions: Record<string, { pressed; released; held }>;
  axes: Record<string, number>;
  axes2D: Record<string, { x; y }>;
  gamepadConnections: Array<{ gamepadIndex; connected }>;
}
```

- **`resolve(events)`** — apply one tick's events and retain action transitions along the event sequence. A complete tap between ticks reports both `pressed` and `released` while final `held` is false; the next empty tick reports neither edge. Multiple bindings still combine into one action, so releasing one binding while another remains held does not release the action.
- **`kind: "2d"`** axes fold x/y bindings into `axes2D[name]`; magnitude also exposed on `axes[name]` for 1D callers.
- **Cursor.** Primary `kind: "pointer"` (mouse or first `pointerId`; extra fingers ignored) keeps `{ x, y, pressed }` in canvas CSS pixels. XY sticks after up/cancel. `kind: "mouse"` updates the cursor when no pointer is primary. Touch uses the same cursor sample as mouse.

Pure with respect to the browser — feed synthetic streams from the deterministic harness.

## Runtime TickContext

`World` receives an optional `input` slice each tick (`packages/object-model/src/objects.ts`):

| API | Source |
| --- | --- |
| `isActionHeld(action)` | `actions[action].held` |
| `wasActionPressed(action)` | `actions[action].pressed` |
| `wasActionReleased(action)` | `actions[action].released` |
| `getAxis(axis)` | `axes[axis]` |
| `getAxis2D(axis)` | `axes2D[axis]` |
| `gamepadConnections` | connection transitions this tick |
| `setGamepadRumble(index, intensity, durationMs)` | forwarded to main thread when supported |

Wired in `packages/runtime/src/driver.ts`: ring buffer → `InputResolver.resolve` → `TickContext` for script/physics phases. Each `tick()` consumes **all** events queued since the previous tick. Event `tick` is recorded on traces; it does not gate consumption. Play's worker host stamps canvas/gamepad samples with the last worker `stats.tickIndex` (not `performance.now() / 16.67`), so compiled `GetAxis` / `GetAxis2D` graphs see the same stick as the overlay HUD.

## Project Settings

**Input** category in Project Settings (`apps/editor/src/components/settings-modal.tsx`): structured `InputMappingEditor` with a searchable action/axis overview, binding summaries, and one selected mapping's details. Each binding uses a device Select and searchable `BindingCodePicker`; modifiers and axis tuning stay in optional detail controls with full labels and `NumberField` inputs. Names reject empty/duplicate values. Plain borders and whole-row selection replace colored edge bars and type marks. Desktop remains compact; touch uses larger targets and a responsive detail layout. Touch bindings pick known control ids (`joystick-x` / `joystick-y` / `dpad-x` / `dpad-y` / `Jump`). Persists through `updateProjectSettings({ input })` + `normalizeInputMappings(..., { allowIncomplete: true })`. Runtime still strips incomplete bindings. Authoring uses structured pickers; runtime graphs can listen for a player's replacement keyboard key.

Unconnected graph `action` / `axis` string pins (Is Action Held, Get Axis, …) are Inspector enums populated from `settings.input`. TouchDPad shares the analog-stick path with defaults `dpad-x` / `dpad-y`.

Runtime receives mappings via `RuntimeDriverOptions.inputMappings` / `setInputMappings`. Normal Play forwards the project's authored mappings in its load message; exports store them in the manifest for the player. Missing mappings in older projects/builds use defaults. Explicit empty action/axis arrays remain empty through save, reload and runtime normalization.

Keyboard gameplay capture belongs to the focused Play/player canvas. Starting a session or pressing the canvas focuses it; text fields and toolbar buttons retain their native keyboard behavior while focused. Canvas/window blur and free-camera takeover release held gameplay keys so movement cannot remain latched after focus changes.

## Testing

Per engineplan §11.1: input is tested through **synthetic event streams** replayed by the deterministic harness and `InputResolver` unit tests — not by driving a browser. P4 raw capture tests remain separate from mapping resolution. Runtime tests also cover live gamepad events stamped with a host wall-clock tick (the Play worker skew) so `GetAxis2D("Move")` cannot silently stay at `{x:0,y:0}`. E2e: `e2e/p5-scripting.spec.ts` injects a synthetic pad and asserts a compiled Tick → GetAxis2D → Print overlay.

## Scripting nodes (`@babylonslate/scripting-nodes`)

### Runtime rebinding

Project Settings owns the game's default mappings. Rebinding creates session-local overrides by mapping kind (`action` / `axis`), name, and zero-based binding index: index `0` is the first binding in that mapping's Project Settings list. Changing one keyboard slot leaves gamepad/touch alternatives and axis direction, dead zone, scale, and sensitivity intact. Rebinding never rewrites `project.json`; separate Input assets are unnecessary for these project-wide defaults.

| Node | Behaviour |
| --- | --- |
| Get Input Binding | Read the current device, code, human label, modifiers, and whether the slot exists. |
| Set Input Binding | Replace one slot's device/code/modifiers; return Success. |
| Begin Input Rebind | Listen for the next fresh non-modifier keyboard key, including held Ctrl/Shift/Alt/Meta. Return whether listening started. |
| Get Input Rebind Status | Read `idle`, `listening`, `completed`, or `cancelled`, plus boolean status pins. |
| Cancel Input Rebind | Cancel active listening without changing the binding. Escape also cancels. |
| Reset Input Mapping / Reset All Input Bindings | Restore the project's authored defaults for one mapping or every mapping. |
| Export Input Bindings / Import Input Bindings | Serialize/restore a versioned JSON string of player overrides. Import returns Success and rejects invalid data without partially applying it. |

For a rebinding menu, call Begin Input Rebind for the selected row, show a listening prompt, then use Get Input Rebind Status on Tick to refresh its label after completion/cancellation. Keys already held when listening starts do not complete capture. Captured keys are consumed until released, so confirming a new binding cannot also trigger gameplay. Capture is keyboard-only; Set Input Binding supports the other device codes from the authoring catalog. Conflicting bindings are allowed, matching existing multiple-action mappings; games can compare Get Input Binding results if their UI requires exclusivity.

The `RuntimeDriver.inputBindings` service is exposed to compiled graphs during Begin Play as well as Tick, including worker Play and the exported player. Existing raw capture forwards arbitrary keyboard codes from the focused game canvas. Overrides survive scene changes within a session. Export the string into the game's own save/profile storage and import it when that profile loads; exporting alone does not persist data across sessions and does not introduce a SaveGame node or automatic browser storage. Keep saves scoped to the game/profile. Renaming a mapping or removing/reordering binding slots changes override identity; stale imports are rejected, allowing the game to retain its new authored defaults.

| Node | Behaviour |
| --- | --- |
| `IsActionHeld` | `ctx.isActionHeld(action)` |
| `GetAxis` | `ctx.getAxis(axis)` |
| `GetAxis2D` | `ctx.getAxis2D(axis)` |
| `OnAction` | exec on pressed / released |
| `OnGamepadConnected` / `OnGamepadDisconnected` | exec on pad transitions |
| `SetGamepadRumble` | `ctx.setGamepadRumble(...)` |
| `GetCursorPosition` | `ctx.getCursorPosition()` → `{ x, y, pressed }` (VEC2 + Pressed). Touch emulates the cursor. |
| `ProjectCursorToScene` | Deproject the Play camera (no Babylon) + world `lineTrace`. Channel, Draw Debug **default on** (red line, green square at hit, Duration 0), Hit Result plus World Origin / World Direction. |
| `ShowCursor` / `HideCursor` | `{ type: "setCursorVisible", visible }`. Play CSS cursor starts **hidden**. Touch Show draws a geometric ring (no artwork). |

Canvas CSS size rides `sceneLayerResize` (`canvasWidth` / `canvasHeight`) so Project Cursor can convert pixels to NDC.

See [bridge.md](bridge.md) for the raw input ring buffer wire format. Overlay 2DButton clicks (including touch / `pointercancel`) are [scene-layers.md](scene-layers.md), not extra input nodes.
