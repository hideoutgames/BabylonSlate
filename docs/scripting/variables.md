# Variables

Variables store values on each object of a class, such as health, a score or a target actor.

## Add a variable

1. In the **Class** window, tap **+** next to **Variables**.
2. Pick a type. The new variable is called **NewVariable**; type a name and press <kbd>Enter</kbd>.
3. Select the variable to edit its settings in the **Inspector**.

## Settings

| Setting | Description |
| --- | --- |
| Name | The name shown on its nodes. Renaming updates every Get and Set node. |
| Category | Groups variables into folders in the **Class** window. Separate subfolders with a vertical bar, for example `Combat\|AI`. |
| Type | The kind of value. See [Pin Types](pin-types.md). |
| Container | **Single** (one value), **Array** (an ordered list) or **Map** (values looked up by key). |
| Key Type | Maps only: the type of the keys. |
| Class Type | Object, Actor and Class variables: the class they accept. Subclasses are accepted too. |
| Asset Type | Asset variables: the kind of asset, such as Audio or Material. |
| Enum Type, Record Type | Enum and structure variables: the [Enum, Structure](structures-and-enums.md) or [Data Definition](data.md) to use. |
| Unit | Integer, Float and Vector variables: shows a unit after the value in number fields, such as 90° for **Degrees** or 16 px for **Pixels**. The value itself is unchanged. The default value, array and map items, and the value input of Set nodes show it. |
| Loading | Asset and Class variables: **Soft (Load On Demand)** loads on first use or through the load nodes; **Hard (Load With Owner)** loads with the object. |
| Default | The starting value. Arrays use **Add Item** and maps use **Add Entry**. Object and Actor variables start empty. |

Changing the type or container resets the default.

## Get and set values

- Drag a variable from the **Class** window onto the graph, then choose **Get** or **Set**. Single Object and Actor variables also offer **Validated Get**.
- Or open the variable's context menu and choose **Get** or **Set**.
- **Add Node** lists a Get and Set entry for each variable of this class and its parents.

| Node | What it does |
| --- | --- |
| [Get Variable](class/get-variable.md) | Returns the current value. It appears as a compact pill named after the variable. |
| [Set Variable](class/set-variable.md) | Writes a new value and passes it on through its output. |
| [Validated Get](class/validated-get.md) | Continues through **Is Valid** or **Not Valid**, depending on whether the variable holds an object. |

To read or write a variable on another object, drag from a pin that holds that object and pick the Get or Set entry. The node gets a **Target** pin.

Use [Is Valid](class/is-valid.md) or **Validated Get** before using an Object or Actor variable that may be empty.

## Arrays and maps

Work with containers through the **Array** and **Map** nodes, such as [Array Get](class/array-get.md), [Map Get](class/map-get.md) and [For Each](class/for-each.md). [Make Array](class/make-array.md) and [Make Map](class/make-map.md) build one from wired values.

## Component variables

In an actor class, every component also appears in the **Class** window as a Get-only variable in the **Components** folder. Select it to change its **Category** in the **Inspector**; clear the field to show it without a folder. Drag it onto the graph, then drag from its pin to reach that component's settings and functions. See also [Get Component](class/get-component.md).

## Local variables

A local variable exists only inside one function and starts from its default each time the function runs.

1. Open the function's tab. The **Class** window shows a **Local Variables** section.
2. Tap **+** next to **Local Variables** and pick a type.

Local variables appear in **Add Node** only while their function is open.
