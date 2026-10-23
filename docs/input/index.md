# Input

Input Actions and Input Axes turn keys, mouse buttons, gamepad controls, on-screen joysticks, touch gestures and device tilt into named inputs your graphs respond to.

## Actions and axes

| Asset | Value | Examples |
| --- | --- | --- |
| [Input Action](../assets/input-action.md) | On or off. | Jump, Interact, Fire |
| [Input Axis](../assets/input-axis.md) | A number from -1 to 1, or an X and Y pair. | Move, Look, Throttle |

Create them in the **Content Browser** with **New Asset > Input > Input Action** or **Input Axis**. Each input is its own asset, so you can rename, move and reference it like any other.

## Add controls

Open the asset. The **Bindings** window lists its controls; the **Inspector** edits the selected one.

1. Tap **Add Control** and choose **Keyboard**, **Mouse Button**, **Gamepad Button**, **Gamepad Axis** or **Touch**.
2. Pick the control from its list. For a key, you can tap **Listen** and press it instead; <kbd>Esc</kbd> cancels.
3. Add more controls as needed. Any of them can trigger the input.

For an Input Axis, set **Value** to **1D · Number** or **2D · X and Y**. **Add Preset** adds **WASD**, **Arrow Keys**, **Left Stick** or **Right Stick** in one step.

| Setting | Description |
| --- | --- |
| Shift Required, Control Required, Alt Required, Command / Windows Required | Keyboard only. The control counts only while that modifier is held, on either side of the keyboard. |
| Direction | 2D axes. Whether the control drives **X · Horizontal** or **Y · Vertical**. |
| Value When Held | Axes, for keys and buttons. The value while held, such as -1 for left and 1 for right. |
| Scale | Axes, for sticks and Touch controls. Multiplies the stick value. |
| Dead Zone | Axes, for sticks and Touch controls. Small movements below this are ignored. |
| Sensitivity | Axes, for sticks and Touch controls. An extra multiplier, useful for look controls. |
| Invert | Axes. Flips the sign. |

## Devices

- **Gamepads:** up to four. Buttons use layout-neutral names such as **Face Button Down**, **Left Bumper** and **D-Pad Up**, so one binding works for any standard controller.
- **Mouse:** Left, Middle, Right, Back and Forward buttons.
- **Touch:** the first finger on the screen acts as **Mouse Left**, so a Mouse Left binding also responds to taps. Every finger is also available to graphs, see [Touch](#touch). For on-screen controls, build a [Scene Layer](../scenes/scene-layers.md) with buttons, or add a [2D Joystick](../components/2d-joystick.md) and bind its **Joystick X**, **Joystick Y**, **D-Pad X** or **D-Pad Y** axis with a **Touch** control. A finger on a 2D Joystick, or on a Scene Layer control such as a 2D Slider, 2D Checkbox or 2D Text Input, is used only by that control: it does not also act as Mouse Left. A 2D Button press still does.

## Respond to input in a graph

In **Add Node**, the **Input** category has [Event Input Action](../scripting/class/event-input-action.md), [Event Input Axis](../scripting/class/event-input-axis.md) and an **Event** entry for each Input asset in the project, such as **Event Jump**.

| Pin | Runs or returns |
| --- | --- |
| Started | Once when the input becomes active. |
| Held | Every tick while active, including the first. |
| Released | Once when the input stops. Connect it to stop movement. |
| Value | True or false for an action; a number or Vector 2 for an axis. |
| Held Seconds | How long the current press has lasted. |
| Last Held Seconds | How long the last press lasted. |

When several controls are active at once, an action stays held until all are released, and axis values add up and are clamped to -1 to 1. A quick tap between two ticks still runs both **Started** and **Released**.

Input events work in the event graphs of classes that tick, such as Actors. They do not work in functions or Animation Graphs.

## More input nodes

| Node | Use |
| --- | --- |
| [On Any Key Pressed](../scripting/class/on-any-key-pressed.md) | Runs for every newly pressed key, button or stick. |
| [Get Cursor Position](../scripting/class/get-cursor-position.md) | The pointer position on the game view. |
| [Project Cursor To Scene](../scripting/class/project-cursor-to-scene.md) | What is under the pointer in the world. |
| [Show Cursor](../scripting/class/show-cursor.md), [Hide Cursor](../scripting/class/hide-cursor.md) | Show or hide the pointer over the game view. |
| [Set Gamepad Rumble](../scripting/class/set-gamepad-rumble.md) | Vibrates a gamepad. |
| [Vibrate Device](../scripting/class/vibrate-device.md) | Vibrates an Android phone or tablet. iPhone and iPad browsers cannot vibrate. |
| [On Gamepad Connected](../scripting/class/on-gamepad-connected.md), [On Gamepad Disconnected](../scripting/class/on-gamepad-disconnected.md) | Run when a pad appears or goes away. |

Menus in Scene Layers can also be driven by your inputs: **Project Settings > Focus Navigation** picks the Input assets that move focus between buttons.

## Touch

The touch nodes see every finger on the game view, plus pen tips and the left mouse button, so a touch game also works with a mouse. Each touch has a **Finger** number: the lowest number not in use when it begins, starting at 0. It keeps that number until it ends.

| Node | Use |
| --- | --- |
| [On Touch Began](../scripting/class/on-touch-began.md), [On Touch Moved](../scripting/class/on-touch-moved.md), [On Touch Ended](../scripting/class/on-touch-ended.md) | Run once for each touch that begins, moves or ends in a tick. |
| [Get Touch Count](../scripting/class/get-touch-count.md), [Get Touch](../scripting/class/get-touch.md) | Read every touch this tick, lowest finger first. |
| [Find Touch](../scripting/class/find-touch.md) | Read the touch with a given finger number, to follow one finger. |
| [Project Touch To Scene](../scripting/class/project-touch-to-scene.md) | What is under a touch in the world. |

Each node also returns the whole touch as a **Touch** structure:

| Field | Description |
| --- | --- |
| Finger | The touch's finger number. |
| Position | Where the touch is, in pixels from the top-left corner of the game view. |
| Delta | How far it moved this tick, in pixels. |
| Velocity | How fast it moves, in pixels per second, smoothed over the last few ticks. On **On Touch Ended** it is the speed of a flick. |
| Start Position | Where it began. |
| Pressure | From 0 to 1. A pen reports how hard it presses; fingers and mice without pressure report 0.5. |
| Phase | **Began**, **Moved**, **Stationary**, **Ended** or **Cancelled** this tick. |
| Type | **Finger**, **Pen** or **Mouse**. |

A touch that ends is still listed for that one tick, with its **Phase** set to **Ended**, or **Cancelled** when the device or a 2D Scroll Box took it over. Touches on a 2D Joystick or a Scene Layer control such as a 2D Slider are left to that control and never appear in the touch nodes.

### Gestures

Haptic recognizes common gestures from the touches. Bind them like any other control: in an Input Action or Input Axis, choose **Add Control > Touch** and pick one from the **Gestures** group. One input can take a gesture and a key together, such as **Swipe Up** and <kbd>Space</kbd> on a Jump action.

| Control | Active | Value |
| --- | --- | --- |
| Tap | For one tick, when a finger lifts within half a second without moving more than 8 pixels. | 1 |
| Double Tap | For one tick, on a second tap within 0.3 seconds and 32 pixels of the first. The second tap is also a **Tap**. | 1 |
| Long Press | From when a finger has stayed down half a second without moving more than 8 pixels, until it lifts or another finger touches the screen. | 1 |
| Swipe Up, Swipe Down, Swipe Left, Swipe Right | For one tick, when a finger lifts at least 48 pixels from where it began, within half a second. The direction is the one it moved most in. | 1 |
| Pinch | While two fingers spread apart or close in. | How much farther apart they are than last tick: 0.1 means 10% farther, and closing in is negative. |
| Two-Finger Rotate | While two fingers turn around each other. | The turn this tick in radians; clockwise is positive. |
| Two-Finger Drag X, Two-Finger Drag Y | While two fingers move together. | The movement this tick, as a fraction of the shorter side of the game view. Right and up are positive. |

- Tap, Double Tap, Long Press and the swipes count only for a finger that was alone on the screen, so two fingers never tap or swipe.
- Gestures are timed in real time, so they behave the same while the game slows down or pauses time with time dilation.
- Pinch, Two-Finger Rotate and Two-Finger Drag follow the two lowest-numbered fingers, from the tick both are down.
- Values per tick are small. Use the control's **Scale** or **Sensitivity** to turn them into the speed your game needs.
- For the speed of a swipe, read **Velocity** from [On Touch Ended](../scripting/class/on-touch-ended.md).

## Motion

Phones and tablets can be steered by tilting them. In an Input Action or Input Axis, choose **Add Control > Touch** and pick one from the **Motion** group:

| Control | Value |
| --- | --- |
| Tilt X, Tilt Y | From the calibrated pose, -1 to 1: X is positive when the right side tips down, Y when the top edge tips away. 30° is a full 1. |
| Shake | Active for one tick when the device is shaken firmly, at most once every 0.75 seconds. |

Bind **Tilt X** and **Tilt Y** to the X and Y of a 2D Input Axis to steer with tilt, alongside a stick or keys.

| Node | Use |
| --- | --- |
| [Get Device Motion](../scripting/class/get-device-motion.md) | The tilt, acceleration and rotation rate. |
| [Calibrate Tilt](../scripting/class/calibrate-tilt.md) | Make the current pose zero tilt, so players can hold the device at any angle. |

- Tilt starts from the device lying flat until the game calibrates it, and follows the screen when it turns to landscape.
- The motion sensors stay off until the game uses a motion control or node. On iPhone and iPad the player is then asked to allow motion on their next tap; if they refuse, tilt stays at zero.
- Computers have no motion sensors, so motion stays at zero there. Test motion on a phone or tablet.

## In this section

- [Rebinding](rebinding.md): let players change their controls at runtime.
