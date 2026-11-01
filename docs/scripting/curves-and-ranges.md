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

**Min** is meant to be at most **Max**. Every range node treats a range whose ends cross as if they were swapped, axis by axis for vectors and rotators.

## Curves

| Structure | Keys |
| --- | --- |
| **Float Curve** | **Float Curve Key** values. |
| **Vector Curve** | **Vector Curve Key** values: one key holds the whole vector. |
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

**Before** and **After** take a **Curve Extrapolation**:

| Extrapolation | Outside the keys |
| --- | --- |
| **Constant** | Holds the first or last key's value. |
| **Linear** | Continues at the slope the curve has at that end. |
| **Cycle** | Repeats the keys. |
| **Oscillate** | Repeats the keys forwards, then backwards. |

A curve without keys is zero everywhere, and a curve with one key holds that key's value. Keys are kept at least 0.001 seconds apart.

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
