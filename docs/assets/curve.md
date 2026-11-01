# Curve

A **Float Curve**, **Vector Curve** or **Color Curve** asset holds one curve that many classes share, such as damage that falls off with distance or a tint over a particle's life. Edit it in one place and every script that reads it uses the new curve.

Use a curve variable instead when only one class needs the curve. See [Curves and ranges](../scripting/curves-and-ranges.md).

## Create

In the **Content Browser**, choose **New Asset > Data > Float Curve**, **Vector Curve** or **Color Curve**. A new curve rises from 0 at 0 seconds to 1 at 1 second; a new **Color Curve** fades from transparent black to opaque white.

## Editor

Double-tap a curve asset to open it.

- **Curve Editor**: a large curve plot with the same keys, tangents, pan, zoom and **Fit** as the [Inspector curve editor](../scripting/curves-and-ranges.md#edit-curves-in-the-inspector). A **Color Curve** also shows its gradient above the channel curves.
- **Details**: the number of keys, the time range, and a **Description**.

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
