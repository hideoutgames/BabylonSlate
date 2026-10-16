# Functions

A function is a named graph with inputs and outputs that you can call from events and other functions.

## Add a function

1. In the **Class** window, tap **+** next to **Functions** and choose **New Function**.
2. Type a name and press <kbd>Enter</kbd>. The function opens in its own tab beside **Event Graph**, with an [Input](class/input.md) node wired to an [Output](class/output.md) node.
3. Build the logic between **Input** and **Output**.

Select a function in the **Class** window to reopen its tab. Renaming a function updates its tab and this class's Call nodes; deleting it closes the tab and removes them.

## Settings

Select the function in the **Class** window to edit it in the **Inspector**.

| Setting | Description |
| --- | --- |
| Name | The function's name, shown on its Call nodes. |
| Overridable | Lets child classes replace this function. Off by default. |
| Category | Groups functions into folders in the **Class** window. |
| Inputs | Values passed in. They appear as outputs of the **Input** node and as inputs of each Call node. |
| Outputs | Values returned. They appear as inputs of the **Output** node and as outputs of each Call node. |

Move a pin up or down in **Inputs** or **Outputs** to reorder it on the nodes.

## Call a function

- Drag the function from the **Class** window onto the graph, or choose **Call** followed by its name in **Add Node**. Both place a [Call Function](class/call-function.md) node.
- To call a function on another object, drag from a pin that holds that object and choose the Call entry. The node gets a **Target** pin.
- The caller continues once the function reaches its **Output** node. If the function contains a latent node such as [Delay](class/delay.md), its Call node becomes latent too and waits for it.
- An output the function never sets returns its type's default value.

## Local variables

Variables that only one function needs belong in **Local Variables**, which appears in the **Class** window while the function's tab is open. They start from their default each time the function runs. See [Variables](variables.md#local-variables).

## Override a parent function

1. In the parent class, turn on **Overridable** for the function.
2. In the child class, tap **+** next to **Functions**. The menu lists the parent's overridable functions, marked with the parent's name.
3. Pick one. The child gets a function with the same name, inputs and outputs, and its version runs instead of the parent's.

If an override's inputs or outputs no longer match the parent, **Compiler Results** reports an error. The same menu lists the methods of the class's [Script Interfaces](interfaces.md).

## Function libraries

A Function Library holds functions that every Class graph in the project can call, without a target object.

1. Create a Class with **FunctionLibrary** as its parent. See [Classes](classes.md).
2. Add functions as usual. A library has only **Functions** and **Local Variables**: no variables, events or interfaces.
3. In any other graph, open **Add Node** and choose **Call** followed by the function's name.

An **EditorFunctionLibrary** works the same way, but its functions can be called only from editor tools. See [Editor scripting](editor-scripting.md).
