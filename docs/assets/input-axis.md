# Input Axis

A named analogue input, such as Move, Look or Throttle: a number from -1 to 1, or an X and Y pair.

## Create

In the **Content Browser**, choose **New Asset > Input > Input Axis**.

## Editor

Double-tap the asset to open it. The window has **Bindings** and an **Inspector**.

- Set **Value** to **1D · Number** or **2D · X and Y**.
- **Add Control** adds a **Keyboard**, **Mouse Button**, **Gamepad Button**, **Gamepad Axis** or **Touch** control. Touch controls are the axes a [2D Joystick](../components/2d-joystick.md) drives: **Joystick X**, **Joystick Y**, **D-Pad X** and **D-Pad Y**, the [gestures](../input/index.md#gestures), such as **Pinch** and **Two-Finger Drag X**, and the device's [tilt](../input/index.md#motion): **Tilt X** and **Tilt Y**. **Add Preset** adds **WASD**, **Arrow Keys**, **Left Stick** or **Right Stick** in one step.
- Select a control to edit it in the **Inspector**. The values of all active controls add up and are clamped to -1 to 1.

## Settings

| Setting | Description |
| --- | --- |
| Shift Required, Control Required, Alt Required, Command / Windows Required | Keyboard controls only. The control counts only while that modifier is held. |
| Direction | 2D axes. Whether the control drives **X · Horizontal** or **Y · Vertical**. |
| Value When Held | Keyboard, Mouse Button and Gamepad Button controls. The value while held, such as -1 for left and 1 for right. |
| Scale | Gamepad Axis and Touch controls. Multiplies the stick value. |
| Dead Zone | Gamepad Axis and Touch controls. Movements below this are ignored. |
| Sensitivity | Gamepad Axis and Touch controls. An extra multiplier, useful for look controls. |
| Invert | Flips the sign. |

## Use it

In a graph, add the axis's **Event** node from the **Input** category of **Add Node**. Its **Value** pin returns a number, or a Vector 2 for a 2D axis. See [Input](../input/index.md).

## Related

- [Input](../input/index.md)
- [Input Action](input-action.md)
- [Event Input Axis](../scripting/class/event-input-axis.md)
- [Rebinding](../input/rebinding.md)
