# Pin Types

Every data pin and variable has a type. A wire connects two pins only when their types are compatible, and pins and wires are coloured by type.

## Types

| Type | Holds |
| --- | --- |
| Bool | True or false. |
| Int | A whole number. |
| Float | A number with decimals. |
| String | Text. |
| Tag, TagContainer | One tag, or a set of tags. See [Tags](tags.md). |
| Enum | One member of an [Enum](structures-and-enums.md). |
| Vector 2, Vector 3, Vector 4 | Two, three or four numbers, such as a position or direction. |
| Rotator | A rotation as pitch, yaw and roll, in degrees. |
| Quaternion | A rotation as a quaternion. |
| Color | A red, green, blue and alpha colour. |
| Transform | A location, rotation and scale. |
| Object | A live object of a chosen class, or nothing. |
| Actor | A live actor of a chosen class, or nothing. |
| Class | A class itself rather than an object, such as the class to pass to [Spawn Actor](class/spawn-actor.md). |
| Asset | An asset of one type, such as an Audio or Material asset. |
| Structure / Data Definition | A record of named fields. See [Structures and Enums](structures-and-enums.md) and [Data](data.md). |
| Wildcard | Any value. Node reference pages call this type Any. |

A variable can also hold an **Array** or a **Map** of a type, and many nodes have array or map pins. See [Variables](variables.md).

## Conversions

- An Int connects to a Float pin directly. Going the other way needs [Float To Int](class/float-to-int.md).
- An object or actor connects to a pin for its own class or any parent class. To go the other way, use [Cast To](class/cast-to.md).
- Class pins accept a class or any of its subclasses, but not an object.
- Asset pins need the same asset type. A Material Instance also fits a Material pin, and a Render Target Texture fits a Texture pin.
- Structure and Enum pins need exactly the same Structure or Enum.
- To show a value as text, use a To String node, such as [To String (Float)](class/to-string-float.md), or [Format String](class/format-string.md).

## Wildcards

Haptic has two kinds of wildcard pin:

- **Generic pins**, on nodes such as [Array Get](class/array-get.md), [For Each](class/for-each.md) and [Select](class/select.md), take the type of the first wire you connect. The node's other generic pins then use that type too.
- **Any pins**, such as the **Value** of [Print](class/print.md), accept every type. To turn an Any value back into a typed value, use a Wildcard To node such as [Wildcard To float](class/wildcard-to-float.md). It returns **Success** and uses **Fallback** when the value has another type. [Wildcard Type Of](class/wildcard-type-of.md) and [Wildcard Is](class/wildcard-is.md) check the type first.

## Inline values

An unconnected input can hold a value, edited on the node or under **Defaults** in the **Inspector**.

- Bool, Int, Float, String, vectors, Rotator, Quaternion, Color, Tag, TagContainer, Enum, Class and Asset inputs have inline editors. Color opens a colour picker; confirm it with **Done**.
- Object and Actor inputs must be wired. The exception is a **Target** pin that shows **Self** when unconnected: it uses the object running the graph.
- Build arrays with [Make Array](class/make-array.md), maps with [Make Map](class/make-map.md), structures with [Make Structure](class/make-structure.md) and transforms with [Make Transform](class/make-transform.md).

Text values are saved when you press <kbd>Enter</kbd> or leave the field; <kbd>Esc</kbd> cancels. To stop accidental edits on touch screens, turn on **Engine Settings > Graph > Read-Only Pin Defaults**. The **Inspector** stays editable.
