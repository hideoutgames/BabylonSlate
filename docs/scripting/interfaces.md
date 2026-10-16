# Script Interfaces

A Script Interface is a set of methods that any class can implement, so you can call the same method on different kinds of objects without casting.

For example, a Damageable interface with an Apply Damage method lets a weapon damage enemies, crates and doors alike.

## Create a Script Interface

1. In the **Content Browser**, choose **New Asset > Scripting > Script Interface**.
2. Open it. In **Methods**, tap **Add method** (**+**).
3. Select the method. In the **Inspector**, set its **Name** and add **Pins**. Each pin has a name, a type and a direction: inputs are passed in, outputs are returned.

**Preview** shows the method as a function node. See [Script Interface](../assets/script-interface.md) for the editor.

## Implement it in a class

1. In the class's **Class** window, tap **+** next to **Interfaces** and pick the Script Interface.
2. Tap **+** next to **Functions**. The menu lists each method of the interface, marked with the interface's name.
3. Pick a method. Haptic adds a function with the method's name and pins, marked **Interface Implementation** in the **Inspector**. Its name, inputs and outputs are locked to the interface.
4. Build the function's logic.

Every method of an interface the class lists must be implemented; a missing one is an error in **Compiler Results**. Give each output of the **Output** node a wire or a value.

Child classes inherit their parent's interfaces and implementations. A child can replace an inherited implementation with its own function of the same name.

## Call a method

In **Add Node**, choose **Call Interface** followed by the method name. This places a [Call Interface Function](class/call-interface-function.md) node with the method's inputs and outputs.

- Connect **Target** to the object to call. Left unconnected, it calls the object running the graph.
- The caller continues when the method returns.
- If the target does not implement the interface, nothing runs: execution continues and the outputs return their default values.

## Notes

- Changing a method's pins updates every Call Interface node and removes wires to pins that no longer exist. An implementing function whose pins no longer match reports an error in **Compiler Results**.
- Use interfaces when unrelated classes share a behaviour. When the classes share a parent, an **Overridable** function on the parent is simpler; see [Functions](functions.md#override-a-parent-function).
