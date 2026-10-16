# Rebinding

Let players change their controls from a settings menu while the game runs.

Rebinding nodes change the player's copy of the bindings, never the Input assets. The changes last until the game stops, so save them yourself if they should carry over to the next session.

## Rebinding nodes

| Node | Use |
| --- | --- |
| [Get Input Bindings](../scripting/class/get-input-bindings.md) | Lists an input's current bindings, as an array of **Input Binding**, for a settings menu. |
| [Set Input Action Binding](../scripting/class/set-input-action-binding.md), [Set Input Axis Binding](../scripting/class/set-input-axis-binding.md) | Replaces the key of one binding and keeps its modifiers, direction and tuning. |
| [Add Input Action Binding](../scripting/class/add-input-action-binding.md), [Add Input Axis Binding](../scripting/class/add-input-axis-binding.md) | Adds a key, with optional **Binding Options** for modifiers and axis tuning. |
| [Remove Input Action Binding](../scripting/class/remove-input-action-binding.md), [Remove Input Axis Binding](../scripting/class/remove-input-axis-binding.md) | Removes a key from an input. |
| [Reset Input Bindings](../scripting/class/reset-input-bindings.md) | Restores one input to its authored bindings. |
| [Reset All Input Bindings](../scripting/class/reset-all-input-bindings.md) | Restores every input. |
| [Export Input Bindings](../scripting/class/export-input-bindings.md), [Import Input Bindings](../scripting/class/import-input-bindings.md) | Turn the player's changes into text and back, for saving. |

Keys are values of the **Key** enum: keyboard keys, five mouse buttons, and the buttons and sticks of four gamepads. **None** binds nothing.

## Build a "press a key" menu

1. Call **Get Input Bindings** for the input and show one row per binding, using its **Label** and **Key**.
2. When the player picks a row, store that **Input Binding** in a variable and set a Boolean such as Waiting to true.
3. Add [On Any Key Pressed](../scripting/class/on-any-key-pressed.md). Behind a [Branch](../scripting/class/branch.md) on Waiting, pass its **Key** and the stored binding to **Set Input Axis Binding** (or **Set Input Action Binding**).
4. When **Success** is true, set Waiting to false and refresh the menu.

Replacing W in a WASD binding keeps it on the Y direction with a positive value, so only the key changes.

::: warning
Rebinding does not pause gameplay input. While Waiting is true, your game should ignore the input it is about to rebind.
:::

## Keep the player's choices

1. After a change, call **Export Input Bindings** and store the text, for example in a [save game](../scripting/save-games.md).
2. At start, read the text back and pass it to **Import Input Bindings**.

The text holds only the changes, so later edits to your Input assets still reach players who never rebound those controls. Import checks the whole text first and changes nothing if it is not valid.

## Related

- [Input](index.md)
- [Input Action](../assets/input-action.md)
- [Input Axis](../assets/input-axis.md)
