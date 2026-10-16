# Input

Input Action / Input Axis assets, the `@babylonslate/input` mapping model and resolver, runtime tick wiring and player rebinding.

## Ownership

| Area | Source |
| --- | --- |
| Mapping types, defaults, normalization | [`packages/input/src/mappings.ts`](../../../packages/input/src/mappings.ts) |
| Bindable codes and labels (`bindingCodesForDevice`, `bindingCodeLabel`) | [`packages/input/src/binding-catalog.ts`](../../../packages/input/src/binding-catalog.ts) |
| Input asset documents | [`packages/input/src/input-assets.ts`](../../../packages/input/src/input-assets.ts), [`packages/core/src/input-assets.ts`](../../../packages/core/src/input-assets.ts) |
| Player rebinding profile | [`packages/input/src/input-bindings.ts`](../../../packages/input/src/input-bindings.ts) |
| `InputResolver` | [`packages/input/src/resolver.ts`](../../../packages/input/src/resolver.ts) |
| `InputRingBuffer`, wire encoding | [`packages/input/src/ring-buffer.ts`](../../../packages/input/src/ring-buffer.ts) |
| DOM capture (Play and player) | [`packages/input/src/dom-input-capture.ts`](../../../packages/input/src/dom-input-capture.ts) (`@babylonslate/input/dom`) |
| Tick wiring | [`packages/runtime/src/driver.ts`](../../../packages/runtime/src/driver.ts) |
| `TickContext` input API | [`packages/object-model/src/objects.ts`](../../../packages/object-model/src/objects.ts) |
| Graph nodes | [`packages/scripting-nodes/src/input.ts`](../../../packages/scripting-nodes/src/input.ts), [`input-bindings.ts`](../../../packages/scripting-nodes/src/input-bindings.ts); event gating in [`packages/scripting/src/compile.ts`](../../../packages/scripting/src/compile.ts) |

## Decisions

- Inputs are assets (`InputAction`, `InputAxis`), not Project Settings rows. Project settings carry no input mappings.
- Identity is the asset GUID. There are no name aliases or conversion markers; the name-keyed `actions` / `axes` views combine every asset sharing a display name (held if any is held; axis values add and clamp to ±1).
- Loading a project never synthesizes input assets or recreates deleted ones. Only the 3D template ships Jump / Confirm / Move / Look; an explicit empty catalog means no defaults. A runtime started without `inputAssets` falls back to starter controls.
- Touch Control is no longer an authoring option; primary touch is Mouse Left. Synthetic touch controls are not in starter defaults.
- The obsolete string-based input nodes, Input Control / Input Device types and capture-status workflow are removed; do not re-add them.
- The resolver is pure with respect to the browser: test it with synthetic event streams and the deterministic harness, not by driving a browser.

## Formats

- `InputAction` / `InputAxis` are version 1 `.babasset` documents with `valueType` and stable-id `bindings`. Normalization drops bindings without an id or with a repeated id. Registry headers hold value type; full bindings live in the document chunk.
- Mapping model: `ActionMapping { name, bindings[] }`, `AxisMapping { name, kind: "1d" | "2d", bindings[] }`. A binding targets `key` / `mouseButton` / `gamepadButton` / `gamepadAxis` / `touch` with a device `code` and optional modifiers. Axis bindings add `deadZone`, `scale`, `invert`, `sensitivity`, `component` (x/y), `digitalValue`.
- `normalizeInputMappings()` drops empty codes (so a blank draft is never mouse button 0); a missing list is empty, never replaced by defaults.
- Gamepad codes stay `padIndex:buttonIndex`; labels are layout-agnostic Standard Gamepad names.
- Player rebinding export is version 2 `edits` keyed by asset GUID and binding id; import validates the whole profile and rejects other versions. Games own persistence and menu gating; the nodes never write browser storage or suppress gameplay input.
- `encodeInputEvents` stores `pointerId` as signed 32-bit and `button` as signed 8-bit; the format is transient and shared by host and worker builds.

## Resolver semantics

- `resolve(events)` folds one tick's events. A complete tap between ticks reports both pressed and released; multiple bindings combine, so releasing one while another is held keeps the action held.
- Event pins: Started, Held (every tick including the first), Released, Value, Held Seconds, Last Held Seconds. Pausing does not advance held time. A release/repress in one tick emits Released, Started, then Held.
- Axes keep an internal `activeValue` (last nonzero sample in the tick) so SceneLayer focus sees quick taps.
- Gamepad samples carry the whole pad state (omitted buttons count as released). Hosts push `gamepadDisconnect` when a pad disappears; the resolver reports one `connected: false` and drops its held state.
- Primary pointer only drives the cursor; chorded mouse buttons are turned into per-button edges by DOM capture, and an `up` for a never-pressed button releases the whole contact.
- On Any Key Pressed emits each new Key press once in input order; repeats and held samples never retrigger. Gamepad axes trigger when |value| crosses 0.5.

## Runtime

- Ring buffer → `InputResolver.resolve` → `TickContext` for script and physics phases. Each `tick()` consumes all events queued since the previous tick; event `tick` stamps are recorded in traces, not used to gate.
- Play's worker host stamps samples with the latest published snapshot `tickIndex`, never the throttled stats command or wall clock.
- `InputRingBuffer(512)` in capture and runtime. At capacity it coalesces the oldest continuous sample only when no resolver threshold edge (0 and 0.5) is lost; edges may grow to 4× capacity; releases are never dropped.
- `setGamepadRumble` clamps intensity to 0..1; Play and player use the pad's `vibrationActuator` `dual-rumble`.
- Input events belong in ticking runtime class graphs, not functions or animation rules.
