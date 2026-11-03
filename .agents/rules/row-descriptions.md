# Row descriptions

Inspector, Details and settings rows show a label and a control. Explanatory text under a row is visual noise: do not add it.

- **No visible explanations.** Never put a sentence under a row that explains what it does: no visible `FieldDescription`, no muted `<p>` after a control, no `PropertyRow.status` used for an explanation.
- **Most rows need nothing.** Leave out text that restates the label or the control, names the type, default, unit or range the control already shows, says a name must be unique, or describes what any control of its kind does. Put the full explanation in the docs page.
- **Tooltip when the label cannot say it.** For something the user needs and the row cannot show (a non-obvious effect, a requirement, how it interacts with another setting), use one short sentence as the label's tooltip:
  - `PropertyRow.description` in a `PropertyGrid` (it renders as a `LabelHint` and stays the control's screen-reader description);
  - `LabelHint` from `@haptic/editor-kit` around the `FieldLabel` of a hand-built `Field`.
- **Graph nodes and pins** follow the same rule: a node's explanation is its title's tooltip (`GraphEditor.describeNode`) and a pin's is its name's (`SerializedPin.description`); the node Inspector shows it only as its heading's tooltip (`ModuleStage.hint`), never as a paragraph.
- **Visible only for live state.** Text the user must see without asking may stay visible: an error (`PropertyRow.error`, `FieldError`), a missing requirement, why a control is disabled, or what it currently resolves to (`PropertyRow.status`).
- Removing a redundant description is always in scope for a change that touches the row.
