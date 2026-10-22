# Input

Input Actions and Input Axes turn keys, mouse buttons, gamepad controls and on-screen joysticks into named inputs your graphs respond to.

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
- **Touch:** the first finger on the screen acts as **Mouse Left**, so a Mouse Left binding also responds to taps. Every finger is also available to graphs, see [Touch](#touch). For on-screen controls, build a [Scene Layer](../scenes/scene-layers.md) with buttons, or add a [2D Joystick](../components/2d-joystick.md) and bind its **Joystick X**, **Joystick Y**, **D-Pad X** or **D-Pad Y** axis with a **Touch** control. A finger on a 2D Joystick or another on-screen control is used only by that control: it does not also act as Mouse Left.

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
| Start Position | Where it began. |
| Pressure | From 0 to 1. A pen reports how hard it presses; fingers and mice without pressure report 0.5. |
| Phase | **Began**, **Moved**, **Stationary**, **Ended** or **Cancelled** this tick. |
| Type | **Finger**, **Pen** or **Mouse**. |

A touch that ends is still listed for that one tick, with its **Phase** set to **Ended**, or **Cancelled** when the device or a Scene Layer scroll box took it over. Touches on a 2D Joystick or another on-screen control in a Scene Layer are left to that control and never appear in the touch nodes.

## In this section

- [Rebinding](rebinding.md): let players change their controls at runtime.
