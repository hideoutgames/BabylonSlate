# Input Action

A named on-or-off input, such as Jump, Interact or Fire, triggered by any of its controls.

## Create

In the **Content Browser**, choose **New Asset > Input > Input Action**.

## Editor

Double-tap the asset to open it. The window has **Bindings** and an **Inspector**.

- **Bindings** lists the action's controls. Tap **Add Control** and choose **Keyboard**, **Mouse Button**, **Gamepad Button**, **Gamepad Axis** or **Touch**. A Gamepad Axis control holds the action while the stick is pushed more than halfway; a Touch control while its [2D Joystick](../components/2d-joystick.md) axis is pushed more than halfway right or up, or while its [gesture](../input/index.md#gestures) is active, such as a **Tap**, a **Swipe Up** or a [**Shake**](../input/index.md#motion).
- For a key, tap **Listen** and press the key you want. <kbd>Esc</kbd> cancels.
- Select a control to edit it in the **Inspector**. Any control can trigger the action.

## Settings

| Setting | Description |
| --- | --- |
| Shift Required, Control Required, Alt Required, Command / Windows Required | Keyboard controls only. The control counts only while that modifier is held. |

Controls are alternatives: holding any one keeps the action active.

## Use it

In a graph, add the action's **Event** node from the **Input** category of **Add Node**, such as **Event Jump**. Its **Started**, **Held** and **Released** pins run as the action begins, continues and ends. See [Input](../input/index.md).

## Related

- [Input](../input/index.md)
- [Input Axis](input-axis.md)
- [Event Input Action](../scripting/class/event-input-action.md)
- [Rebinding](../input/rebinding.md)
