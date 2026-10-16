# Global Search

Search the whole project for assets, actors, components, graph nodes, classes and variables, then jump straight to the result.

## Open Search Project

Choose the search button in the toolbar, or press <kbd>Mod</kbd>+<kbd>K</kbd>. On a phone, choose **More Tools > Search Project**.

When the window opens, Haptic reads the project and shows **Indexing Project** for a moment. The index includes unsaved changes in open documents.

## Search

Type part of a name. Matching is not case-sensitive, and exact and starting matches come first.

Results are grouped:

| Group | What matches | Choosing a result |
| --- | --- | --- |
| Assets | Asset names, types and paths | Opens the asset, or selects it in the Content Browser if it has no editor. |
| Actors | Actor names and classes in every scene | Opens the scene and selects the actor. |
| Components | Components on actors, and their short text settings | Opens the scene and selects the actor. |
| Graph Nodes | Node titles in Class graphs | Opens the Class and focuses the node. |
| Classes | Your Classes and the engine's built-in classes | Opens your Class. Built-in classes are listed for reference. |
| Variables | Get and Set nodes for a variable | Opens the graph at that node. |

Search shows up to 80 results. If what you want is missing, type more of its name.

## Keyboard

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move through results. |
| <kbd>Enter</kbd> | Open the highlighted result. |
| <kbd>Esc</kbd> | Close the window. |

## Notes

- Content in disabled plugins is not searched. Enabled plugin content is, even when **Show Plugin Content** is off.
- Search looks at names and short text, not inside textures, models or sounds.
- To filter the Content Browser grid instead, use its own search field (<kbd>Mod</kbd>+<kbd>F</kbd> while it has focus).
