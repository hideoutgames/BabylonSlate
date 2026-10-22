# Display names

Every user-facing name is **Title Case**: each word capitalized, spaces kept, acronyms preserved (`2D Camera Width`, `Mesh Kind`, `3D (Havok)`, `Reload Scene`). Never sentence case, `2 d camera width` or a raw camelCase key. Identifiers stay as they are: catalog ids are dotted camelCase (`flow.event.beginPlay`), pin ids and codegen names camelCase (`deltaSeconds`, `onBeginPlay`).

- Event node titles read `Event Begin Play`, `Event On Hit`; class member names store only the body (`Begin Play`). Format typed or generated names with `formatEventMemberName` / `formatEventTitle` from `@haptic/editor-kit`.
- Run property keys and free-typed labels through `humanizePropertyLabel` so `2D`, `3D`, `UI` and `ID` stay acronyms. Hardcoded Inspector `label:` strings are written in Title Case.
- Scripting node `title` values (`Get Actor Location`, `Execute JavaScript`), pin display names (`Delta Seconds`), buttons, menus and catalog titles follow the same rule.
