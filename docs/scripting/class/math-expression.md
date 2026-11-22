---
node: math.expression
---

# Math Expression

Computes a formula of numbers and vectors that you type on the node. Its names become the node's input and output pins.

## Settings

| Setting | Description |
| --- | --- |
| Formula | The formula. You can also type it on the node itself. |
| Input Types | One row per input: **Auto** takes the type of the wire connected to it, or pick **Float**, **Vector2**, **Vector3** or **Vector4**. |

## Notes

- A new node has no pins. Double-click the formula on the node (double-tap on a touch screen, or select the node and press Enter) to type one. Press Ctrl+Enter (Cmd+Enter on a Mac) or click away to apply it; Escape cancels. Enter alone starts a new line.
- Every name you use but never assign becomes an input pin, in the order the names first appear. Every name you assign becomes an output pin. A formula that is a single expression, such as `a * 2 + b`, has one output called **Result**.
- An unconnected input shows a value field on the node, as on other nodes.
- One Math Expression node runs faster than the same formula built from separate math nodes: it computes the whole formula at once, and an output nothing is connected to costs nothing. The results are exactly those of the separate nodes.
- While you play, the debugger shows the node's input and output values, not the steps inside the formula.
- A formula with an error keeps the pins it last had, so its wires are not lost while you fix it. The error, with its line and column, shows on the node, in the **Inspector** and in **Compiler Results**.

## Formulas

Write one statement per line, or separate statements with `;`. Text after `//` is a comment.

| Statement | Meaning |
| --- | --- |
| `name = expression` | An output pin called `name`. |
| `let name = expression` | A value you can use in later lines. It has no pin. |
| `expression` | The only statement: one output called **Result**. |

A name starts with a letter or `_` and holds letters, digits and `_`; capitals matter. You cannot assign a name twice or use a name before the line that assigns it.

### Operators

From the tightest to the loosest:

| Operator | Meaning |
| --- | --- |
| `v.x` `v.y` `v.z` `v.w` | One component of a vector. |
| `a ^ b` | `a` to the power `b`, as [Power](power.md). `a ^ b ^ c` is `a ^ (b ^ c)`. |
| `-a` | Negates a number or vector, as [Negate](negate.md). `-a ^ 2` is `-(a ^ 2)`. |
| `a * b` `a / b` `a % b` | Multiply, divide and modulo, as [Multiply](multiply.md), [Divide](divide.md) and [Modulo](modulo.md). |
| `a + b` `a - b` | Add and subtract, as [Add](add.md) and [Subtract](subtract.md). |
| `( )` | Groups. |

### Types

- Values are **Float**, **Vector2**, **Vector3** or **Vector4**. Numbers you type are Floats. An Integer wire gives a Float input.
- Operators work as their nodes do: two vectors of the same size work per component, and a number with a vector works on every component. `%` and `^` take Floats only.
- A formula that mixes types the wrong way, such as a Vector2 plus a Vector3, is an error.

### Functions and constants

Each function gives exactly what its node gives, including the node's rules for values outside its range: dividing by 0 gives 0, the square root of a negative number gives 0, and the logarithm of a number not above 0 gives 0.

| Function | Node |
| --- | --- |
| `sin(a)` `cos(a)` `tan(a)` | [Sin (Radians)](sin.md), [Cos (Radians)](cos.md), [Tan (Radians)](tan.md) |
| `asin(a)` `acos(a)` `atan(a)` `atan2(y, x)` | [Asin (Radians)](asin.md), [Acos (Radians)](acos.md), [Atan (Radians)](atan.md), [Atan2 (Radians)](atan2.md) |
| `sind(a)` `cosd(a)` `tand(a)` | [Sin (Degrees)](sin-degrees.md), [Cos (Degrees)](cos-degrees.md), [Tan (Degrees)](tan-degrees.md) |
| `asind(a)` `acosd(a)` `atand(a)` `atan2d(y, x)` | [Asin (Degrees)](asin-degrees.md), [Acos (Degrees)](acos-degrees.md), [Atan (Degrees)](atan-degrees.md), [Atan2 (Degrees)](atan2-degrees.md) |
| `sqrt(a)` `abs(a)` `sign(a)` | [Sqrt](sqrt.md), [Abs](abs.md), [Sign](sign.md) |
| `floor(a)` `ceil(a)` `round(a)` `frac(a)` | [Floor](floor.md), [Ceil](ceil.md), [Round](round.md), [Fraction](fraction.md) |
| `min(a, b)` `max(a, b)` `clamp(value, min, max)` | [Min](min.md), [Max](max.md), [Clamp](clamp.md) |
| `wrap(value, min, max)` | [Wrap](wrap.md) |
| `lerp(a, b, alpha)` | [Lerp](lerp.md); with two vectors, [Lerp Vector3](lerp-vector3.md) and its Vector2 and Vector4 forms. Alpha is not clamped. |
| `pow(base, exp)` `exp(a)` | [Power](power.md), [Exp](exp.md) |
| `ln(a)` `log(a)` `log(a, base)` | [Natural Log](natural-log.md), [Logarithm](logarithm.md) (base 10 when you leave it out) |
| `vec2(x, y)` `vec3(x, y, z)` `vec4(x, y, z, w)` | [Make Vector2](make-vector2.md), [Make Vector3](make-vector3.md), [Make Vector4](make-vector4.md) |
| `dot(a, b)` `length(v)` `distance(a, b)` `normalize(v)` | [Dot Vector3](dot-vector3.md), [Length Vector3](length-vector3.md), [Distance Vector3](distance-vector3.md), [Normalize Vector3](normalize-vector3.md), and their Vector2 and Vector4 forms |
| `cross(a, b)` | [Cross Vector3](cross-vector3.md) |

The constants are `pi`, `tau` (2 × pi) and `e`. Function and constant names cannot be used as variable names. Functions other than `lerp` and the vector functions take Floats.

A formula is at most 4000 characters, 64 statements and 32 levels of nesting, and a name at most 64 characters.

### Examples

```
y = clamp((target - current) * gain, -limit, limit)
```

```
let toTarget = normalize(target - position)
position2 = position + toTarget * speed * deltaSeconds
facing = atan2d(toTarget.x, toTarget.z)
```

## Renaming variables

When you change the formula, a variable you renamed keeps its wire, value and type: exactly one input (or output) name has gone and one new name appears in the same place, with the same type. Otherwise the wires of names that are gone are removed. Either way, one **Undo** puts the formula and its wires back.

## Converting

Right-click a node (or touch and hold) for:

- **Convert to Math Expression**: shown when every selected node is a math node a formula can express (the operators, the functions above and Break Vector nodes, with Float and vector pins). It replaces the selection with one Math Expression node at its centre. Each wire into the selection becomes an input (one per source pin), unconnected values become numbers in the formula, a value used by several selected nodes becomes a `let`, and each value wired outside the selection becomes an output. The results are identical.
- **Convert to Math Nodes**: on a Math Expression node, replaces it with the equivalent math nodes, laid out left to right, with its wires reconnected. It is unavailable while the formula has an error.

Both are one step to undo.
