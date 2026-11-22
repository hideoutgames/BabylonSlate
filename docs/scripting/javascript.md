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

## Extension libraries

The body can call the game library of any enabled [gameplay extension](../projects/extensions.md#gameplay-extensions) through `extensions`, named by its **Library Name**:

```js
chance = extensions.weather.rainChance(humidity);
```

## Pin names

Pin names are case-sensitive variable names. Each must be a valid JavaScript identifier, must not be a reserved word or `extensions`, and must be unique across **Inputs** and **Outputs**. The **Inspector** shows an error under the lists when a name is not allowed, and the node fails when it runs.

## Errors

Syntax errors in the body appear in **Compiler Results**. Tap the result to go to the node.

## Trusted projects

The body is not sandboxed: it runs with the same access as the rest of your game, in Play, in Simulate and in packaged games. So a project that came from somewhere else, such as a repository you cloned, a folder someone sent you or a template, must be trusted on this computer before its Execute JavaScript runs. This is the same [Workspace Trust](../projects/extensions.md#trust-project-extensions) that holds back project extensions.

- In a project this computer does not trust, **Play**, **Simulate**, **Preview Build** and packaging stop with a message when anything they would run contains Execute JavaScript with code in its body. A Scene, Class or other asset that a running game loads later and that contains it stops loading with the same message.
- The banner above the documents then names the assets. Choose **Trust Project**, or turn on **Trust This Project** under **Editor Utility Objects** in **Project Settings > General**. It takes effect at once; play again. Turning **Trust This Project** off takes effect at once too.
- Projects you create in Haptic are trusted. Projects without Execute JavaScript play as before, whether trusted or not.
- Only nodes with code count: an empty body, or one of only spaces, does not. A body that holds only a comment counts. Nodes not connected to anything that runs are left out of the game, so they do not count either.
- Trust belongs to the project's folder on this computer. Pulling changes into a trusted project with [Source Control](../projects/source-control.md) keeps it trusted, so review incoming Classes and Scenes for Execute JavaScript before you play them.
- A packaged game holds whatever Execute JavaScript the project had when you packaged it. The game itself does not check again.
- When you import assets or plugins that contain Execute JavaScript, Haptic lists them first. See [Importing Assets](../editor/importing.md#assets-with-execute-javascript).

## Notes

- On touch screens, the code editor shows a key bar with braces, brackets, parentheses, semicolons, quotes, comparison signs and **Tab**.
- Only use code you trust, and review it in projects or plugins you import.
- For most logic, regular nodes are easier to read and debug. Use this node for calculations or text handling that would need many nodes.
- An Animation Graph's **Preview** never runs Execute JavaScript.
