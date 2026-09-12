# Input assets and events

Create **Input Action** or **Input Axis** from the Content Browser's **Input** category. Inputs are assets, not Project Settings rows. Open an asset to edit its dockable **Bindings** and **Details** panels. Actions produce a boolean; axes produce a 1D number or 2D X/Y value. Add Control uses readable device catalogs, Listen captures a keyboard chord (Escape or window blur cancels), and axis presets add WASD, arrow keys, or either gamepad stick. Click anywhere on a binding row, or press Enter/Space on its selection control, to select its Details. The trailing trash icon removes the row. Details contains modifiers, direction, scale, dead zone, sensitivity, and inversion. Mouse Button includes mouse clicks and primary touch-as-left-click; Pointer Button and Touch Control are no longer authoring options.

## Graph workflow

The **Input** category contains **Event Input Action**, **Event Input Axis**, **On Any Key Pressed**, and `Event <asset name>` shortcuts. Action/axis events accept an **Input Binding** struct and listen to the entire action/axis identified by its Input field. An unwired event has a filtered asset dropdown with no extra Choose Input entry. A wired event uses its generic title; dynamic axes expose **Axis Dimensions** (1D/2D) in Details. Events belong in ticking runtime class graphs, not functions or animation rules.

**Make Structure** creates graph-local data without a variable reference. Select its Structure Type in Details, or add **Make <Struct>** directly for any engine/project structure, including **Make Input Binding**. Pins and field defaults follow the live schema. **Break <Struct>** exposes its fields.

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

The native **Key** enum uses the same catalog as Input Action/Axis authoring: keyboard codes, five mouse buttons, and the four supported gamepads' Standard buttons and stick axes. Labels are readable; values such as `KeyW`, `MouseLeft`, and `Gamepad1Button0` retain exact device identity. **None** is an inert default.

**On Any Key Pressed** emits each newly pressed Key once, in input order. Keyboard repeats and held gamepad samples do not retrigger it. Primary touch reports Mouse Left. Gamepad axes emit when their absolute value crosses 0.5, and rearm below that threshold; the event captures an axis identity rather than its direction.

| Node | Use |
| --- | --- |
| Get Input Bindings | Read an asset's Input Binding array for a settings menu. |
| Add Input Action / Axis Binding | Add Key to an asset; optional Binding Options supply modifiers and axis tuning. |
| Set Input Action / Axis Binding | Replace a selected binding's Key while preserving its stable Id, modifiers, X/Y component, sign, and tuning. |
| Remove Input Action / Axis Binding | Remove that Key from the selected asset, including bindings using different modifiers/components. |
| Reset Input Bindings / Reset All Input Bindings | Restore authored defaults. |
| Export / Import Input Bindings | Serialize player overrides for the game's own save storage. |

For WASD rebinding, store the selected **Input Binding**, gate **On Any Key Pressed** with the menu's waiting flag, pass Key to **Set Input Axis Binding**, and clear the waiting flag after success. Replacing W retains its original Y component and positive/negative direction. The game owns menu gating and persistence; these nodes do not automatically write browser storage or suppress gameplay input.

**Input Binding** contains Input (asset GUID/name), Id, Label, Key, Shift/Ctrl/Alt/Meta, the native **Input Component** enum (X/Y), Digital Value, Scale, Dead Zone, Invert, and Sensitivity. Profile additions/removals use version 2 edits; controls still resolve through the device/code mapping model. Imports validate the complete profile before applying it. The obsolete string-based input nodes, Input Control/Input Device types, and capture/status graph workflow have been removed.

## Storage and defaults

`InputAction` and `InputAxis` are version 1 `.babasset` documents with `valueType` and stable-ID `bindings`. Registry headers contain value type; full bindings live in the document chunk. Play uses open document changes first. Export includes all enabled input assets in startup reachability and carries the definitions into the player manifest and worker load message. An explicit empty catalog means no input defaults.

The built-in 3D template includes Jump, Confirm, Move, and Look assets in `assets/Input`. Blank and 2D projects start without Input assets; custom templates supply their own authored controls. Loading a project does not convert Project Settings mappings, synthesize input assets, or recreate deleted controls. Input identity is the asset GUID; there are no old-name aliases or conversion markers.

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

`InputMappings` = `{ actions[], axes[] }`. `normalizeInputMappings()` coerces unknown `project.json` payloads and **drops empty `code`s** so Play never treats a blank mouse/pointer draft as button 0. Input asset authoring passes `{ allowIncomplete: true }` so device switches and Add Binding keep `{ device, code: "" }` rows until a control is picked. `createDefaultInputMappings()` supplies Jump / Confirm / Move / Look defaults. Default **Move** includes keyboard and gamepad stick bindings. **Jump** includes Space and Gamepad 1 Face Button Down; **Confirm** uses Enter and Face Button Right. Synthetic touch controls are no longer included in starter defaults.

Gamepad picker labels are layout-agnostic Standard Gamepad names (Face Button Down/Right/Left/Up, bumpers, triggers, Left/Right Stick Click, D-Pad, Home). Stored codes stay `padIndex:buttonIndex`. Closed bindings stay pad-qualified (`Gamepad 1 Face Button Down`); picker rows show the button name under a `Gamepad N` group.

## InputResolver

Stateful fold of `RawInputEvent[]` → per-tick snapshot:

```ts
interface ResolvedInputTick {
  actions: Record<string, { pressed; released; held }>;
  axes: Record<string, number>;
  axes2D: Record<string, { x; y }>;
  gamepadConnections: Array<{ gamepadIndex; connected }>;
  pressedKeys: InputKey[];
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
| `getPressedKeys()` | ordered physical Key rising edges this tick |
| `setGamepadRumble(index, intensity, durationMs)` | forwarded to main thread when supported |

Wired in `packages/runtime/src/driver.ts`: ring buffer → `InputResolver.resolve` → `TickContext` for script/physics phases. Each `tick()` consumes **all** events queued since the previous tick. Event `tick` is recorded on traces; it does not gate consumption. Play's worker host stamps canvas/gamepad samples with the last worker `stats.tickIndex` (not `performance.now() / 16.67`), so compiled Input Axis events see the same stick as the host input stream.


## Testing

Per engineplan §11.1: input is tested through **synthetic event streams** replayed by the deterministic harness and `InputResolver` unit tests — not by driving a browser. P4 raw capture tests remain separate from mapping resolution. Runtime tests also cover live gamepad events stamped with a host wall-clock tick (the Play worker skew) so `GetAxis2D("Move")` cannot silently stay at `{x:0,y:0}`. E2e: `e2e/p5-scripting.spec.ts` injects a synthetic pad and asserts a compiled Tick → GetAxis2D → Print overlay.

The typed node catalog is implemented in `packages/scripting-nodes/src/input.ts` and `input-bindings.ts`; compiler event gating lives in `packages/scripting/src/compile.ts`.