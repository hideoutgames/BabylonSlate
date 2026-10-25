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
| Object | A live object of a chosen class, or nothing. Choose **Actor** or one of its subclasses as the class to hold an actor. Pins show the class name, such as **Actor** or **Door**. |
| Class | A class itself rather than an object, such as the class to pass to [Spawn Actor](class/spawn-actor.md). |
| Asset | An asset of one type, such as an Audio or Material asset. |
| Structure / Data Definition | A record of named fields. See [Structures and Enums](structures-and-enums.md) and [Data](data.md). |
| Wildcard | Any value. Node reference pages call this type Any. |

A variable can also hold an **Array** or a **Map** of a type, and many nodes have array or map pins. See [Variables](variables.md).

## Conversions

- An Int connects to a Float pin directly. Going the other way needs [Float To Int](class/float-to-int.md).
- An object connects to a pin for its own class or any parent class, so every actor fits an **Actor** pin and every object fits an **Object** pin. To go the other way, use [Cast To](class/cast-to.md).
- Class pins accept a class or any of its subclasses, but not an object.
- Asset pins need the same asset type. A Material Instance also fits a Material pin, and a Render Target Texture fits a Texture pin.
- Structure and Enum pins need exactly the same Structure or Enum.
- To show a value as text, use a To String node, such as [To String (Float)](class/to-string-float.md), or [Format String](class/format-string.md).

## Wildcards

Haptic has two kinds of wildcard pin:

- **Generic pins**, on nodes such as [Array Get](class/array-get.md), [For Each](class/for-each.md) and [Select](class/select.md), take the type of the first wire you connect. The node's other generic pins then use that type too.
- **Any pins**, such as the **Value** of [Print](class/print.md), accept every type. To turn an Any value back into a typed value, use a Wildcard To node such as [Wildcard To float](class/wildcard-to-float.md). It returns **Success** and uses **Fallback** when the value has another type. [Wildcard Type Of](class/wildcard-type-of.md) and [Wildcard Is](class/wildcard-is.md) check the type first.

## Empty references

A connected reference is used as it is, even when it is empty when the node runs. It never turns into **Self**.

- A node that acts on the object it is given (its **Target**, **Actor**, **Material** or similar input) does nothing when that object is empty, and execution continues. A node that returns a value returns its default instead.
- Each time this happens the **Output Log** and the Play console show an error such as `My Hero: Destroy Actor (Target) tried to access null.`, naming the class the graph belongs to as the **Content Browser** lists it, then the node and the pin. It is shown every time the node runs, not only the first.
- Inputs where an empty value is meaningful do not report it, for example the **Value** of [Set Variable](class/set-variable.md), [Is Valid](class/is-valid.md), the input of [Cast To](class/cast-to.md), the **Owner** of [Set Owner](class/set-owner.md) and the **Parent** of [Attach Actor](class/attach-actor.md).

## Inline values

An unconnected input can hold a value, edited on the node or under **Defaults** in the **Inspector**.

- Bool, Int, Float, String, vectors, Rotator, Quaternion, Color, Tag, TagContainer, Enum, Class and Asset inputs have inline editors. Color opens a colour picker; confirm it with **Done**.
- An input with an inline editor always has a value: the one you set, else the pin's own default, else zero, false or empty. **Compiler Results** never reports it as not connected. The exceptions are Class and Asset inputs, which warn while nothing is selected, and the outputs of an [Interface Implementation](interfaces.md), which need a wire or a value.
- Object inputs must be wired; **Compiler Results** reports them as errors until they are. The exception is a pin whose label ends in **(Self)**, such as **Target (Self)** on [Destroy Actor](class/destroy-actor.md) or **Actor (Self)** on [Get Component](class/get-component.md). While nothing is connected it uses the object running the graph; once you connect a reference the label drops **(Self)**. Calls to a function, custom event or interface function of this graph's own class have such a **Target (Self)** pin, so you can wire in another object of the class instead.
- Build arrays with [Make Array](class/make-array.md), maps with [Make Map](class/make-map.md), structures with [Make Structure](class/make-structure.md) and transforms with [Make Transform](class/make-transform.md).

Text values are saved when you press <kbd>Enter</kbd> or leave the field; <kbd>Esc</kbd> cancels. To stop accidental edits on touch screens, turn on **Engine Settings > Graph > Read-Only Pin Defaults**. The **Inspector** stays editable.
