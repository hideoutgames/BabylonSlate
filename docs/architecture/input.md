# Input mappings (P6)

Mapping model and resolver contract (engineplan §11.1). Raw capture landed in P4; P6 adds the pure mapping layer and Project Settings authoring.

## Mapping model (`@babylonslate/input`)

| Type | Fields |
| --- | --- |
| `ActionMapping` | `name`, `bindings[]` |
| `AxisMapping` | `name`, `kind` (`"1d"` \| `"2d"`), `bindings[]` |

Each **binding** targets a device (`key`, `mouseButton`, `pointer`, `gamepadButton`, `gamepadAxis`, `touch`) plus a device-specific `code`. Optional `modifiers` (shift/ctrl/alt/meta).

**Axis bindings** additionally carry per-binding tuning:

| Field | Role |
| --- | --- |
| `deadZone` | Stick dead zone with remapped live range |
| `scale` | Output multiplier |
| `invert` | Flip sign |
| `sensitivity` | Extra multiplier (e.g. look axes) |
| `component` | `"x"` \| `"y"` for `kind: "2d"` axes |
| `digitalValue` | Constant while a digital binding is held |

`InputMappings` = `{ actions[], axes[] }`. `normalizeInputMappings()` coerces unknown `project.json` payloads; `createDefaultInputMappings()` supplies Jump / Confirm / Move / Look defaults. Default gamepad face bindings: Jump → `0:0` (A), Confirm → `0:1` (B) so both actions do not fire from one button.

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

Wired in `packages/runtime/src/driver.ts`: ring buffer → `InputResolver.resolve` → `TickContext` for script/physics phases.

## Project Settings

**Input** category in Project Settings (`apps/editor/src/components/settings-modal.tsx`): actions and axes authored as JSON, persisted in `project.json` under `settings.input`. Shape matches `ProjectInputSettings` in `@babylonslate/core`; normalisation in `@babylonslate/input`. Engine Settings is a separate modal and does not include input mappings.

Runtime receives mappings via `RuntimeDriverOptions.inputMappings` / `setInputMappings`.

## Testing

Per engineplan §11.1: input is tested through **synthetic event streams** replayed by the deterministic harness and `InputResolver` unit tests — not by driving a browser. P4 raw capture tests remain separate from mapping resolution.

## Scripting nodes (`@babylonslate/scripting-nodes`)

| Node | Behaviour |
| --- | --- |
| `IsActionHeld` | `ctx.isActionHeld(action)` |
| `GetAxis` | `ctx.getAxis(axis)` |
| `GetAxis2D` | `ctx.getAxis2D(axis)` |
| `OnAction` | exec on pressed / released |
| `OnGamepadConnected` / `OnGamepadDisconnected` | exec on pad transitions |
| `SetGamepadRumble` | `ctx.setGamepadRumble(...)` |

See [bridge.md](bridge.md) for the raw input ring buffer wire format.
