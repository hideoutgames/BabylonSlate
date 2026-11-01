# Curve

A **Float Curve**, **Vector Curve** or **Color Curve** asset holds one curve that many classes share, such as damage that falls off with distance or a tint over a particle's life. Edit it in one place and every script that reads it uses the new curve.

Use a curve variable instead when only one class needs the curve. See [Curves and ranges](../scripting/curves-and-ranges.md).

## Create

In the **Content Browser**, choose **New Asset > Data > Float Curve**, **Vector Curve** or **Color Curve**. A new curve rises from 0 at 0 seconds to 1 at 1 second; a new **Color Curve** fades from transparent black to opaque white.

## Editor

Double-tap a curve asset to open it.

- **Curve Editor**: the curve plot fills the window, with the same keys, tangents, pan, zoom and hover readout as the [Inspector curve editor](../scripting/curves-and-ranges.md#edit-curves-in-the-inspector).
  - The toolbar has the channel toggles, **Add Key**, **Remove Key** and **Fit**. **Frame Selection** (<kbd>F</kbd>) also fits the keys.
  - The bar under the plot edits the selected key: step between keys with the arrows, then set its **Time**, each channel's value and its **Interpolation**. With several keys selected it shows how many, and a value you set applies to all of them.
  - A **Color Curve** shows its gradient in a strip above the plot, on the same time axis. Each stop in the strip is a key: tap one to select it, or drag it to change its time. The key bar adds a colour swatch and hex code.
- **Details**:
  - **Curve**: the type, the number of keys, the time range and the value range.
  - **Extrapolation**: **Before** and **After** set what the curve does outside its keys: **Constant** holds the end value, **Linear** continues the end slope, **Cycle** repeats the keys and **Oscillate** repeats them back and forth. The plot hatches these ranges and draws them dashed.
  - **Description**: a note for your team. It can span several lines.

Reopen a closed window from the **Windows** menu.

## Use it in graphs

Choose **Asset** as a variable or pin type and pick **Float Curve**, **Vector Curve** or **Color Curve** as the **Asset Type**. Then:

1. Add [Get Float Curve Object](../scripting/class/get-float-curve-object.md) (or the Vector or Color version) and give it the asset.
2. Read the object with [Get Value At Time](../scripting/class/get-value-at-time-float-curve.md), **Get Time Range**, **Get Key Count** or **Get Float Curve**, which returns a copy you can change.

A Curve Object is a read-only object reference. Pass it into functions or keep it in variables like any object. There is one object per curve asset for the whole session, and it is never collected.

## Loading

A curve asset given to **Get Float Curve Object** loads with the asset that uses it, so the object is ready as soon as the script runs. If the curve asset is not loaded, **Get Float Curve Object** returns None.

## Related

- [Curves and ranges](../scripting/curves-and-ranges.md)
- [Data Definition](data-definition.md)
