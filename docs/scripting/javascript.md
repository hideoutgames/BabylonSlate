# Execute JavaScript

The [Execute JavaScript](class/execute-javascript.md) node runs a short piece of JavaScript inside a graph, for logic that is easier to write as code.

## Add the node

1. In **Add Node**, search for **Execute JavaScript**. It is in the **Debug** category.
2. Select the node. In the **Inspector**, add pins under **Inputs** and **Outputs**. Each pin has a name and a type, and can be **Single**, **Array** or **Map**.
3. Tap **JavaScript Function Body** to open the code editor, write the code, then choose **Done**.

The node keeps its execution input and output. Your pins appear between them.

## Write the body

The body is the inside of a function. Each input pin is a variable you can read, and each output pin is a variable you assign.

For inputs **health** and **damage** (Float) and outputs **newHealth** (Float) and **died** (Bool):

```js
newHealth = Math.max(0, health - damage);
died = newHealth <= 0;
```

- Outputs start at their type's default value, such as 0, false or an empty string, and keep whatever you assign.
- An early `return` ends the body; outputs keep the values assigned so far.
- Arrays arrive as JavaScript arrays and Maps as JavaScript `Map` objects. Objects keep their identity, so you can pass them on to other pins.
- The body runs in strict mode. Assign outputs directly; declaring one again with `let` or `const` is an error.
- The body runs straight through: **Out** continues as soon as it finishes, and `await` is not available.

## Pin names

Pin names are case-sensitive variable names. Each must be a valid JavaScript identifier, must not be a reserved word, and must be unique across **Inputs** and **Outputs**. The **Inspector** shows an error under the lists when a name is not allowed, and the node fails when it runs.

## Errors

Syntax errors in the body appear in **Compiler Results**. Tap the result to go to the node.

## Notes

- On touch screens, the code editor shows a key bar with braces, brackets, parentheses, semicolons, quotes, comparison signs and **Tab**.
- The code runs with the same access as the rest of your game. Only use code you trust, and review it in projects or plugins you import.
- For most logic, regular nodes are easier to read and debug. Use this node for calculations or text handling that would need many nodes.
