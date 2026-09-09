# Input assets and events

Create **Input Action** or **Input Axis** from the Content Browser's **Input** category. Inputs are assets, not Project Settings rows. Open an asset to edit its dockable **Bindings** and **Details** panels. Actions produce a boolean; axes produce a 1D number or 2D X/Y value. Add Control uses readable device catalogs, Listen captures a keyboard chord (Escape or window blur cancels), and axis presets add WASD, arrow keys, or either gamepad stick. Select Details for modifiers, direction, scale, dead zone, sensitivity, and inversion.

## Graph workflow

The Add Node menu has `Event <asset name>` for every input asset under Input/Actions or Input/Axes. Each event uses event colors and an **Input Type** dropdown. Asset GUIDs identify inputs; names are display metadata. Changing the selected asset updates Value's type. Native **Break Input Type** exposes Name and Asset. Input events belong in ticking runtime class event graphs, not functions or animation rules.

| Pin | Behaviour |
| --- | --- |
| Started | Once when the resolved value becomes active. |
| Held | Each simulation tick while active, including the starting tick. |
| Released | Once when the value returns to false or zero. Connect this to stop movement. |
| Value | Boolean for actions, float for 1D axes, X/Y for 2D axes. Multiple bindings combine. |
| Held Seconds | Simulation time elapsed during the current hold; zero on the starting tick and whenever inactive. |
| Last Held Seconds | Duration of the most recently released hold. |

Complete taps between ticks retain both Started and Released. A release/repress in one tick emits Released, Started, then Held. Event outputs describe the final resolved tick value. Pausing does not advance held duration.

## Player rebinding

**Get Input Bindings** takes an Input Type dropdown and returns native **Input Binding** values. Break Input Binding exposes a readable Label for menus, the Input Type, and the typed Control. Use the existing array nodes to select a binding, then **Listen for Input Binding** to capture a replacement keyboard chord. **Get Input Rebind Status** returns the native Input Rebind Status enum; use its enum switch to handle listening, completed, and cancelled. **Cancel Input Rebind** cancels capture. **Set Input Control** takes an Input Binding and a native Input Control with device/control dropdowns, including mouse and gamepad choices. **Reset Input Bindings** restores one asset; **Reset All Input Bindings** restores all defaults.

The existing export/import binding nodes serialize player overrides for the game's own profile storage. They do not automatically save browser data. Version 2 profiles use asset GUIDs and stable binding IDs, so renames and reordering preserve overrides while retaining current axis tuning. Missing bindings reject import atomically. Version 1 profiles remain readable when the old name and authored control identify an unambiguous binding. Capture consumes held and newly captured keys until release to avoid activating gameplay.

## Storage and compatibility

`InputAction` and `InputAxis` are version 1 `.babasset` documents with `valueType`, stable-ID `bindings`, and an optional `legacyName` alias. Registry headers contain value type and compatibility alias; full bindings live in the document chunk. Play uses open document changes first. Export includes all enabled input assets in startup reachability and carries the definitions into the player manifest and worker load message. An explicit empty catalog means no input defaults.

Older projects copy their mappings into `assets/Input` before writing `settings.inputAssetsVersion: 1`. Existing mappings remain in the on-disk manifest until a normal project save. Copy retries recognize already-created assets by their legacy aliases. The marker prevents removed inputs being recreated. Existing string-based graph nodes remain registered for old graphs but are hidden from Add Node; legacy names resolve to migrated assets, even when a newer asset reuses a display name. Duplicates retain controls but leave compatibility aliases on the original asset. New projects author the familiar default controls as assets.

## Mapping model (`@babylonslate/input`)

| Type | Fields |
| --- | --- |
| `ActionMapping` | `name`, `bindings[]` |
| `AxisMapping` | `name`, `kind` (`"1d"` \| `"2d"`), `bindings[]` |

Each **binding** targets a device (`key`, `mouseButton`, `pointer`, `gamepadButton`, `gamepadAxis`, `touch`) plus a device-specific `code`. Optional `modifiers` (shift/ctrl/alt/meta). Bindable codes and labels live in `bindingCodesForDevice()` / `bindingCodeLabel()` (`packages/input/src/binding-catalog.ts`) so the input asset picker and stored-binding labels stay in sync.

**Axis bindings** additionally carry per-binding tuning:

| Field | Role |
| --- | --- |
| `deadZone` | Stick dead zone with remapped live range |
| `scale` | Output multiplier |
| `invert` | Flip sign |
| `sensitivity` | Extra multiplier (e.g. look axes) |
| `component` | `"x"` \| `"y"` for `kind: "2d"` axes |
| `digitalValue` | Constant while a digital binding is held |

`InputMappings` = `{ actions[], axes[] }`. `normalizeInputMappings()` coerces unknown `project.json` payloads and **drops empty `code`s** so Play never treats a blank mouse/pointer draft as button 0. Input asset authoring passes `{ allowIncomplete: true }` so device switches and Add Binding keep `{ device, code: "" }` rows until a control is picked. `createDefaultInputMappings()` supplies Jump / Confirm / Move / Look defaults. Default **Move** includes keyboard, gamepad stick, touch joystick (`joystick-x` / `joystick-y`), and TouchDPad (`dpad-x` / `dpad-y`) so an on-screen stick, d-pad, and a gamepad drive the same `GetAxis2D("Move")` with no script change. Default **Jump** includes Space, gamepad Face Button Down (`0:0`), and touch control id `Jump` (Play overlay virtual stick / d-pad). Default Confirm → `0:1` (Face Button Right) so both actions do not fire from one button.

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


## Testing

Per engineplan §11.1: input is tested through **synthetic event streams** replayed by the deterministic harness and `InputResolver` unit tests — not by driving a browser. P4 raw capture tests remain separate from mapping resolution. Runtime tests also cover live gamepad events stamped with a host wall-clock tick (the Play worker skew) so `GetAxis2D("Move")` cannot silently stay at `{x:0,y:0}`. E2e: `e2e/p5-scripting.spec.ts` injects a synthetic pad and asserts a compiled Tick → GetAxis2D → Print overlay.

## Scripting nodes (`@babylonslate/scripting-nodes`)

#