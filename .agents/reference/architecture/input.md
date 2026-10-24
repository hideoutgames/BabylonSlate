# Input

Input Action / Input Axis assets, the `@haptic/input` mapping model and resolver, runtime tick wiring and player rebinding.

## Ownership

| Area | Source |
| --- | --- |
| Mapping types, defaults, normalization | [`packages/input/src/mappings.ts`](../../../packages/input/src/mappings.ts) |
| Bindable codes and labels (`bindingCodesForDevice`, `bindingCodeLabel`) | [`packages/input/src/binding-catalog.ts`](../../../packages/input/src/binding-catalog.ts) |
| Input asset documents | [`packages/input/src/input-assets.ts`](../../../packages/input/src/input-assets.ts), [`packages/core/src/input-assets.ts`](../../../packages/core/src/input-assets.ts) |
| Player rebinding profile | [`packages/input/src/input-bindings.ts`](../../../packages/input/src/input-bindings.ts) |
| `InputResolver` | [`packages/input/src/resolver.ts`](../../../packages/input/src/resolver.ts) |
| `GestureRecognizer`, gesture codes and thresholds | [`packages/input/src/gestures.ts`](../../../packages/input/src/gestures.ts) |
| `MotionInput`, motion codes, tilt and shake constants | [`packages/input/src/motion.ts`](../../../packages/input/src/motion.ts) |
| `InputRingBuffer`, wire encoding | [`packages/input/src/ring-buffer.ts`](../../../packages/input/src/ring-buffer.ts) |
| DOM capture (Play and player) | [`packages/input/src/dom-input-capture.ts`](../../../packages/input/src/dom-input-capture.ts) (`@haptic/input/dom`) |
| Tick wiring | [`packages/runtime/src/driver.ts`](../../../packages/runtime/src/driver.ts) |
| `TickContext` input API | [`packages/object-model/src/objects.ts`](../../../packages/object-model/src/objects.ts) |
| `TouchInput` (`engine:Touch`), `TOUCH_PHASES`, `TOUCH_TYPES` | [`packages/core/src/touch-input.ts`](../../../packages/core/src/touch-input.ts) |
| Graph nodes | [`packages/scripting-nodes/src/input.ts`](../../../packages/scripting-nodes/src/input.ts), [`input-bindings.ts`](../../../packages/scripting-nodes/src/input-bindings.ts); event gating in [`packages/scripting/src/compile.ts`](../../../packages/scripting/src/compile.ts) |

## Decisions

- Inputs are assets (`InputAction`, `InputAxis`), not Project Settings rows. Project settings carry no input mappings.
- Identity is the asset GUID. There are no name aliases or conversion markers; the name-keyed `actions` / `axes` views combine every asset sharing a display name (held if any is held; axis values add and clamp to ±1).
- Loading a project never synthesizes input assets or recreates deleted ones. Only the 3D template ships Jump / Confirm / Move / Look; an explicit empty catalog means no defaults. A runtime started without `inputAssets` falls back to starter controls.
- Primary touch is Mouse Left. `touch` bindings are authored with **Add Control > Touch**; their codes are the 2D Joystick's axes (`joystick-x`/`-y`, `dpad-x`/`-y`, read as analog axes like `gamepadAxis`) and the gestures (picker group "Gestures"). A `touch` code reads the joystick value first, then the gesture's when the joystick's is 0. Synthetic touch controls are not in starter defaults.
- Gestures are recognized in the resolver from its own touch records (no wire changes), with fixed thresholds rather than settings: tap within 8 px and under 0.5 s; double tap within 0.3 s and 32 px of the previous tap; long press at 0.5 s within 8 px, held until the lift or until another contact begins; swipe at the lift, at least 48 px within 0.5 s, dominant axis. Single-finger gestures need a contact that was alone for its whole life. Tap fires for each tap of a double tap (no delay waiting for a second tap). Swipe speed is the touch's `Velocity`, not a binding (axes clamp at ±1).
- Gesture timing and touch `Velocity` use `resolve`'s `inputSeconds` (the driver's undilated step), not the dilated game `deltaSeconds` that Held Seconds uses, so time dilation (0 for a pause menu) does not change them. Thresholds allow a 1e-6 s epsilon for summed tick lengths. Given the same events, tick lengths and view size, gestures are deterministic.
- Pulses (tap, double tap, swipes) are 1 for one tick and are cleared before the tick's first `sample`, so a pulse on the next tick starts the input again. Continuous gestures are replaced after the event loop, never cleared first, so a held axis does not release and restart each tick. Pinch (spread ratio − 1), Two-Finger Rotate (radians, clockwise positive) and Two-Finger Drag (midpoint movement over the view's shorter side, up positive; 0 until `setViewSize`, which the driver calls from `applySceneLayerResize`; hosts call `EngineHandle.publishSceneLayerSize` once their runtime exists, because the report `createEngine` makes precedes it) follow the two lowest fingers; a new pair or a just-began finger only sets the baseline.
- Every contact is also a touch: a pointer holding button 0, so a finger, a pen tip or the left mouse button (touch games work with a mouse). Touches are `engine:Touch` struct values built by the resolver itself (the `InputValueState.input` precedent), so scripts read them without a mapping layer.
- Engine UI owns its pointers: a finger that a SceneLayer 2D Joystick, a 2D control or an active scroll drag holds never reaches the ring (`EngineHandle.ownsGamePointer` → capture `ownsPointer`). Ownership is decided at the press and kept until the lift, because the engine releases it in its own pointerup listener first; a pointer taken over later (scroll past its 8 px slop) gets one `cancel`. Capture must attach after `createEngine` so the engine's canvas listeners run first. 2D Button presses are not owned: they still reach the game as Mouse Left.
- The obsolete string-based input nodes, Input Control / Input Device types and capture-status workflow are removed; do not re-add them.
- The resolver is pure with respect to the browser: test it with synthetic event streams and the deterministic harness, not by driving a browser.

## Formats

- `InputAction` / `InputAxis` are version 1 `.hasset` documents with `valueType` and stable-id `bindings`. Normalization drops bindings without an id or with a repeated id. Registry headers hold value type; full bindings live in the document chunk.
- Mapping model: `ActionMapping { name, bindings[] }`, `AxisMapping { name, kind: "1d" | "2d", bindings[] }`. A binding targets `key` / `mouseButton` / `gamepadButton` / `gamepadAxis` / `touch` with a device `code` and optional modifiers. Axis bindings add `deadZone`, `scale`, `invert`, `sensitivity`, `component` (x/y), `digitalValue`.
- `normalizeInputMappings()` drops empty codes (so a blank draft is never mouse button 0); a missing list is empty, never replaced by defaults.
- Gamepad codes stay `padIndex:buttonIndex`; labels are layout-agnostic Standard Gamepad names.
- Player rebinding export is version 2 `edits` keyed by asset GUID and binding id; import validates the whole profile and rejects other versions. Games own persistence and menu gating; the nodes never write browser storage or suppress gameplay input.
- `motion` (wire kind 8) is ten float32 fields in `MOTION_FIELDS` order.
- `encodeInputEvents` stores `pointerId` as signed 32-bit, `button` as signed 8-bit, then the pointer type (0 not given, 1 mouse, 2 touch, 3 pen) and pressure as float32 (NaN not given); decoding leaves absent fields out. The format is transient and shared by host and worker builds. New raw kinds take bytes 8 and up; 3 and 5 stay retired.

## Resolver semantics

- `resolve(events)` folds one tick's events. A complete tap between ticks reports both pressed and released; multiple bindings combine, so releasing one while another is held keeps the action held.
- Event pins: Started, Held (every tick including the first), Released, Value, Held Seconds, Last Held Seconds. Pausing does not advance held time. A release/repress in one tick emits Released, Started, then Held.
- Axes keep an internal `activeValue` (last nonzero sample in the tick) so SceneLayer focus sees quick taps.
- Gamepad samples carry the whole pad state (omitted buttons count as released). Hosts push `gamepadDisconnect` when a pad disappears; the resolver reports one `connected: false` and drops its held state.
- Primary pointer only drives the cursor; chorded mouse buttons are turned into per-button edges by DOM capture, and an `up` for a never-pressed button releases the whole contact.
- Device motion: `tilt-x`, `tilt-y` (degrees from the calibrated pose over 30, screen-rotated, unclamped until the binding clamps) and `shake` (a pulse after 3 readings of at least 12 m/s² without gravity within 0.5 s, then 0.75 s calm) are `touch` codes in picker group "Motion". Tilt reads `deviceorientation` beta/gamma (the right side down and the top edge away are positive), turned by `screen.orientation.angle`; acceleration and rotation rate come from `devicemotion` and are turned the same way. Calibration survives `reset`; an uncalibrated pose is zero when lying flat.
- Sensors start only on demand: the driver emits `requestDeviceMotion` once, on its first tick when a binding uses a motion code or when a script calls `getDeviceMotion` / `calibrateTilt`; `create-engine` hands it to the host, which calls the capture's `enableMotion` (remembered if capture is not attached yet). Where `DeviceOrientationEvent.requestPermission` exists (iOS), capture asks during the next pointerdown or key press on the canvas; a refusal is final for the session, a rejection (no gesture) waits for the next one.
- Capture sends one `motion` sample per `pollGamepads` (the latest pose and the strongest acceleration since the last sample), nothing while suppressed, and a NaN-pose release at `neutralize` so tilt reads zero without input ownership. Motion samples are never releases and a later sample supersedes an earlier one in the ring.
- Touch `Velocity` is halfway between the last velocity and this tick's movement per second, settled at the lift for an ending contact and after the event loop for live ones; dt 0 keeps it.
- Touches: a contact begins when its pointer starts holding button 0 and ends when it stops (Ended) or is cancelled (Cancelled, keeping its last position). Finger is the lowest slot not held by a live contact or one lifted this tick; lifted contacts stay in `touches` for that tick and free their slot on the next `resolve`. `Delta` is movement since the tick began (since the press for one that began this tick); `touchEvents` holds Began, at most one Moved per contact per tick (updated in place by later moves) and Ended/Cancelled, in input order. Phase in `touches` is Began over Moved over Stationary; Ended or Cancelled wins. Pressure keeps its last sample at the lift (browsers report 0 then) and is 0.5 when absent.
- On Any Key Pressed emits each new Key press once in input order; repeats and held samples never retrigger. Gamepad axes trigger when |value| crosses 0.5.

## Runtime

- Ring buffer → `InputResolver.resolve` → `TickContext` for script and physics phases. `getTouches` / `getTouchEvents` expose the tick's touches; On Touch Began / Moved / Ended are gated `onTick` entries like On Any Key Pressed, and `projectTouchToScene` reuses the cursor's screen-point projection (main camera, or the caller's Scene Layer camera). Each `tick()` consumes all events queued since the previous tick; event `tick` stamps are recorded in traces, not used to gate.
- Play's worker host stamps samples with the latest published snapshot `tickIndex`, never the throttled stats command or wall clock.
- `InputRingBuffer(512)` in capture and runtime. At capacity it coalesces the oldest continuous sample only when no resolver threshold edge (0 and 0.5) is lost; edges may grow to 4× capacity; releases are never dropped.
- `setGamepadRumble` clamps intensity to 0..1; Play and player use the pad's `vibrationActuator` `dual-rumble`.
- `vibrateDevice` clamps its duration to 0..10 000 ms (the browsers' cap) and `create-engine` hands it to `navigator.vibrate` through `applyDeviceVibration` ([`packages/render/src/device-vibration.ts`](../../../packages/render/src/device-vibration.ts)); a missing, refusing or throwing API is ignored. Shipped games are web exports, so iOS (no Vibration API) never vibrates. The Android app declares `VIBRATE` so its WebView can.
- Input events belong in ticking runtime class graphs, not functions or animation rules.
