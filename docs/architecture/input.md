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

`InputMappings` = `{ actions[], axes[] }`. `normalizeInputMappings()` coerces unknown `project.json` payloads and **drops empty `code`s** so Play never treats a blank mouse/pointer draft as button 0. Project Settings authoring passes `{ allowIncomplete: true }` so device switches and Add Binding keep `{ device, code: "" }` rows until a control is picked. `createDefaultInputMappings()` supplies Jump / Confirm / Move / Look defaults. Default **Move** includes keyboard, gamepad stick, touch joystick (`joystick-x` / `joystick-y`), and TouchDPad (`dpad-x` / `dpad-y`) so an on-screen stick, d-pad, and a gamepad drive the same `GetAxis2D("Move")` with no script change. Default **Jump** includes Space, gamepad Face Button Down (`0:0`), and touch control id `Jump` (Play HUD `TouchButton`). Default Confirm → `0:1` (Face Button Right) so both actions do not fire from one button.

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

- **`resolve(events)`** — apply one tick's events; derive `pressed` / `released` from edge detection vs previous held actions.
- **`kind: "2d"`** axes fold x/y bindings into `axes2D[name]`; magnitude also exposed on `axes[name]` for 1D callers.

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

**Input** category in Project Settings (`apps/editor/src/components/settings-modal.tsx`): structured `InputMappingEditor` — Action/Axis `Card`s with a muted header, a **Bindings** group, per-binding device Select, searchable `BindingCodePicker`, explicit Ctrl/Shift/Alt/Meta toggles, and contextual axis extras. Device rows use `TypeColorMark` plus a 2px start-edge pin-token bar (key `--pin-string`, mouse `--pin-object`, pointer `--pin-wildcard`, gamepad button `--pin-bool`, gamepad axis `--pin-vector`, touch `--pin-float`). Actions/Axes legends reuse bool/vector pin colors. Touch bindings pick known control ids (`joystick-x` / `joystick-y` / `dpad-x` / `dpad-y` / `Jump`) plus `controlId*` from open UserInterface documents. Persists through `updateProjectSettings({ input })` + `normalizeInputMappings(..., { allowIncomplete: true })`. Runtime still uses the default stripper. No JSON textarea and no listen-to-bind.

Unconnected graph `action` / `axis` string pins (Is Action Held, Get Axis, …) are Inspector enums populated from `settings.input`. TouchButton widgets pick an action the same way; Play HUD emits that action as a touch axis (1 while held, 0 on release). TouchDPad shares the analog-stick path with defaults `dpad-x` / `dpad-y`.

Runtime receives mappings via `RuntimeDriverOptions.inputMappings` / `setInputMappings`.

## Testing

Per engineplan §11.1: input is tested through **synthetic event streams** replayed by the deterministic harness and `InputResolver` unit tests — not by driving a browser. P4 raw capture tests remain separate from mapping resolution. Runtime tests also cover live gamepad events stamped with a host wall-clock tick (the Play worker skew) so `GetAxis2D("Move")` cannot silently stay at `{x:0,y:0}`. E2e: `e2e/p5-scripting.spec.ts` injects a synthetic pad and asserts a compiled Tick → GetAxis2D → Print overlay.

## Scripting nodes (`@babylonslate/scripting-nodes`)

| Node | Behaviour |
| --- | --- |
| `IsActionHeld` | `ctx.isActionHeld(action)` |
| `GetAxis` | `ctx.getAxis(axis)` |
| `GetAxis2D` | `ctx.getAxis2D(axis)` |
| `OnAction` | exec on pressed / released |
| `OnGamepadConnected` / `OnGamepadDisconnected` | exec on pad transitions |
| `SetGamepadRumble` | `ctx.setGamepadRumble(...)` |
| `Set Input Mode` | `ctx.setInputMode(mode)` — engine enum `engine:InputMode` (All / Interface / Game). Hidden on EUO / EFL. Allowed on Actor / GameInstance / BObject / UserInterface Logic. |

See [bridge.md](bridge.md) for the raw input ring buffer wire format and the `setInputMode` command.

## Input mode vs capture

Play overlay `input-capture.ts` and `apps/player` `input.ts` honor the session mode. **All** (default) feeds the ring and GUI hits follow authored Hit Testable. **Interface** keeps HUD picking and Touch* / TextInput, but does not push key/pointer/gamepad into the resolver (`shouldPushRawInput`; `touchAxis` still flows). **Game** paints HUD but forces `allowGuiHits` false so the Layer ADT does not pick. See [ui-runtime.md](ui-runtime.md).
