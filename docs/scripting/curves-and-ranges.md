# Curves and ranges

Haptic has built-in Structures for two common kinds of tuning value: a **range** (a lowest and a highest value, such as a spawn count of 2 to 5) and a **curve** (a value that changes over time, such as damage that falls off with distance). Choose them like any other Structure: pick **Structure / Data Definition** as the variable or pin type, then the type under **Record Type**.

They are ordinary Structures, so **Make** and **Break** work as for any Structure, and the nodes below add the common reads.

## Ranges

| Structure | Fields |
| --- | --- |
| **Int Range** | **Min** and **Max**, whole numbers. |
| **Float Range** | **Min** and **Max**, numbers. |
| **Vector 2 Range** | **Min** and **Max**, Vector 2 values. |
| **Vector Range** | **Min** and **Max**, vectors. |
| **Rotator Range** | **Min** and **Max**, rotators. |

**Min** is always at most **Max**, axis by axis for vectors and rotators:

- Dragging **Min** past **Max** pushes **Max** along, and the other way round. Drag back and the pushed end returns.
- Typing a **Min** above **Max**, or a **Max** below **Min**, swaps the two when you finish typing.
- A stored range whose ends cross, for example one built with **Make Int Range**, reads as swapped in the **Inspector** and in every range node.

## Edit ranges in the Inspector

A range variable, Structure field, Data Definition field or unwired node pin shows one row:

- **Int Range** and **Float Range** edit **Min** and **Max** side by side in the row.
- **Vector 2 Range**, **Vector Range** and **Rotator Range** show a one-line summary, such as **−5.00, 0.00, −5.00 – 5.00, 2.00, 5.00**. Tap it to expand one **Min** – **Max** pair per axis.

Data Tree grids and the Play **Inspector** show the same summary. In a Data Tree, edit a range in **Values**.

Ranges and curves can also be [Save Game](save-games.md) fields: set the field's **Type** to **Structure** and pick the range or curve.

## Curves

| Structure | Keys |
| --- | --- |
| **Float Curve** | **Float Curve Key** values. |
| **Vector Curve** | **Vector Curve Key** values: a key sets all three axes, or only the axes in its **Axes**. |
| **Color Curve** | **Color Curve Key** values: one key holds the whole color, including alpha. |

A curve has three fields:

- **Keys**: the keys, in time order.
- **Before** and **After**: what the curve does before its first key and after its last key.

Each key has a **Time**, a **Value**, an **Interpolation** and two tangents, **Arrive Tangent** and **Leave Tangent**. A key's interpolation decides how the curve travels from that key to the next one:

| Interpolation | Between this key and the next |
| --- | --- |
| **Constant** | Holds this key's value, then jumps to the next. |
| **Linear** | A straight line. |
| **Auto** | A smooth curve shaped by the neighbouring keys. It stays flat at a peak or a dip, so it does not overshoot them. |
| **Custom** | A smooth curve shaped by the tangents. A tangent is a slope in value per second; Vector and Color keys have one per channel. |
| An easing curve, such as **Quad In** or **Bounce Out** | The same shape as that [easing curve](class/index.md#tween) in Tween nodes. |

A **Vector Curve Key** also has **Axes**: the axes it sets, added up from X 1, Y 2 and Z 4. The default, 7, sets all three. A key that sets fewer leaves the other axes to their own keys, so each axis can have keys at different times and with its own interpolation. Between the curve's first and last key, an axis outside its own keys holds its nearest value; **Before** and **After** apply to the whole curve.

**Before** and **After** take a **Curve Extrapolation**:

| Extrapolation | Outside the keys |
| --- | --- |
| **Constant** | Holds the first or last key's value. |
| **Linear** | Continues at the slope the curve has at that end. |
| **Cycle** | Repeats the keys. |
| **Oscillate** | Repeats the keys forwards, then backwards. |

A curve without keys is zero everywhere, and a curve with one key holds that key's value. Keys are kept at least 0.001 seconds apart.

## Edit curves in the Inspector

A curve variable, Structure field, Data Definition field or unwired node pin shows one row with a preview and its key count:

- A **Float Curve** shows a sparkline.
- A **Vector Curve** shows one sparkline per axis, in the axis colours.
- A **Color Curve** shows its gradient.

Tap the row to expand the editor in place. A **Color Curve** opens as a gradient with stops; tap **Channels** to edit its red, green, blue and alpha curves instead.

In the curve plot:

- A time ruler runs along the top and a value ruler down the side. Outside the first and last key the plot is hatched and the curve is dashed: that part follows **Before** and **After**.
- Tap or click a key to select it, and drag it to change its time and value. On a **Vector Curve**, each axis has its own handle; use **X**, **Y** and **Z** to show or hide axes. The selected axis draws on top.
- On a **Vector Curve**, dragging one axis's handle sideways moves that axis on its own, as its own key; drag it back onto the other axes to join them again. Removing a handle removes only that axis, choosing an interpolation for one axis changes only that axis, and a new key sets the axes that are shown.
- To select several keys, Shift-click to add a key and Ctrl/Cmd-click to add or drop one. With a mouse, drag across empty space to select the keys in a box; on touch, hold empty space, then drag. Tap or click empty space to clear the selection.
- Drag any selected key to move them all together. Arrow keys nudge the selected keys; hold Shift to move ten times as far. **Delete** removes them.
- Double-click empty space to add a key there, or right-click it and choose **Add Key Here**. On touch, hold empty space, lift your finger without moving it, and choose **Add Key Here**.
- Right-drag (or drag with one finger on touch) to pan, and pinch or Ctrl/Cmd-scroll to zoom. Editing keys leaves the view where it is; choose **Fit** to frame every key again.
- **Auto** and **Custom** keys show tangent handles. Drag a handle to set the key's slope; an **Auto** key becomes **Custom** and keeps its shape until you move the handle.
- With a mouse, hover over the plot to read each channel's value at that time.
- Below the plot, edit the selected key's **Time**, **Value** and **Interpolation** (the easing curves are grouped under **Ease**), and the curve's **Before** and **After**. With several keys selected, a field shows **Mixed** where they differ; a value or interpolation you set applies to all of them, and **Time** moves them together.

Each drag, and each other change, is one step in **Undo**. Data Tree grids and the Play **Inspector** show the same previews.

## Curve assets

When many classes should share one curve, make a **Float Curve**, **Vector Curve** or **Color Curve** asset instead of a curve variable. Scripts read it through a read-only **Curve Object**: [Get Float Curve Object](class/get-float-curve-object.md) turns the asset into the object, and nodes such as [Get Value At Time](class/get-value-at-time-float-curve.md) read it. See [Curve](../assets/curve.md).

## Nodes

| Node | What it does |
| --- | --- |
| [Random Integer In Range](class/random-int-in-range.md), [Random Float In Range](class/random-float-in-range.md), [Random Vector 2 In Range](class/random-vector2-in-range.md), [Random Vector In Range](class/random-vector-in-range.md), [Random Rotator In Range](class/random-rotator-in-range.md) | Pick a random value inside a range. Integers include both ends; other values go from **Min** up to, but not including, **Max**. |
| [Clamp Integer To Range](class/clamp-integer-to-range.md), [Clamp Float To Range](class/clamp-float-to-range.md), [Clamp Vector To Range](class/clamp-vector-to-range.md) | Limit a value to a range. |
| [Is Integer In Range](class/is-integer-in-range.md), [Is Float In Range](class/is-float-in-range.md) | Test whether a value is inside a range, both ends included. |
| [Lerp Float Range](class/lerp-float-range.md), [Map Float Range](class/map-float-range.md) | Blend across a range, or remap a value from one range to another. |
| [Evaluate Float Curve](class/evaluate-float-curve.md), [Evaluate Vector Curve](class/evaluate-vector-curve.md), [Evaluate Color Curve](class/evaluate-color-curve.md) | Read a curve's value at a time. |
| [Get Float Curve Time Range](class/get-float-curve-time-range.md), [Get Vector Curve Time Range](class/get-vector-curve-time-range.md), [Get Color Curve Time Range](class/get-color-curve-time-range.md), [Get Float Curve Value Range](class/get-float-curve-value-range.md) | Return the times of the first and last keys, or the lowest and highest key values. |

The Random nodes draw from the session's seeded random generator, the same one [Random Float](class/random-float.md) uses, so Play repeats the same values for the same seed.
