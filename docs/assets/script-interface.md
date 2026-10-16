# Script Interface

A list of methods that any [Class](../scripting/classes.md) can implement, so one call works on different kinds of objects.

## Create

In the **Content Browser**, choose **New Asset > Scripting > Script Interface**.

## Editor

Double-tap the asset to open it. The window has **Methods**, **Preview** and **Inspector**.

- **Methods** lists the methods. Tap **Add method** (**+**) to add one, named NewMethod. Select a method and tap **Remove method** to delete it.
- **Preview** shows the selected method as a function node, with its inputs and outputs.
- The **Inspector** edits the selected method. Tap a pin in **Preview** to select it in the pin list.

## Settings

| Setting | Description |
| --- | --- |
| Name | The method's name. |
| Pins | The method's inputs and outputs. Choose **Add Input** or **Add Output**, then set each pin's name and type. |

An interface has no logic. Each class that implements it builds the method's graph.

## Related

- [Script Interfaces](../scripting/interfaces.md): implement an interface in a class and call its methods.
- [Call Interface Function](../scripting/class/call-interface-function.md)
