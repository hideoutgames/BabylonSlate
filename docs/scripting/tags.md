# Tags

Tags are hierarchical labels, such as `State.Combat.Attacking`, that you store in variables and test in scripts.

## Tag types

| Type | Holds |
| --- | --- |
| Tag | One tag, or None. |
| TagContainer | A set of tags. |

Use them as variable, structure field and pin types. Tags belong to the project, so every class shares the same list.

## Create tags

You create tags from any Tag picker, for example a variable default or an inline pin value.

1. Open the picker (**Select Tag** or **Select Tags**).
2. Under **Create Tag**, type a dotted name such as `Ability.Movement.Dash`.
3. Choose **Create**. The new tag is selected.

Missing parent categories are created too, so `Ability` and `Ability.Movement` appear as well. Each part of a name uses letters, numbers and underscores and starts with a letter or underscore. Names are case-sensitive.

## Pick tags

- A Tag picker selects one tag or category. **Clear Selection** sets it to None.
- A TagContainer picker selects several. Checking a category also checks the children it has now, not ones you add later. **Deselect All** clears it.
- Search filters the list and keeps matching parents visible.
- A value whose tag no longer exists in the project shows **Missing Tag**.

## Test tags

A tag matches its parent categories: `State.Combat.Attacking` matches `State.Combat`, but `State.Combat` does not match `State.Combat.Attacking`. None never matches.

| Node | What it does |
| --- | --- |
| [Matches Tag](class/matches-tag.md) | Tests one tag against a query tag. |
| [Has Tag](class/has-tag.md), [Has Any Tags](class/has-any-tags.md), [Has All Tags](class/has-all-tags.md) | Test a container. |
| [Equal Tag](class/equal-tag.md), [Equal TagContainer](class/equal-tagcontainer.md) | Compare exactly. Container order does not matter. |
| [Switch On Tag](class/switch-on-tag.md), [Select By Tag](class/select-by-tag.md) | Choose a path or a value by tag. |

Turn on **Exact Match** on a node to ignore parent categories. On **Switch On Tag** and **Select By Tag** it is on by default; with it off, the most specific matching case wins.

## Change containers

[Add Tag](class/add-tag.md), [Remove Tag](class/remove-tag.md), [Clear TagContainer](class/clear-tagcontainer.md), [Union Tags](class/union-tags.md), [Intersect Tags](class/intersect-tags.md) and [Difference Tags](class/difference-tags.md) return a new container and leave their input unchanged.

To keep the result, write it back to the variable: wire the variable's Get node into [Assign TagContainer](class/assign-tagcontainer.md) (or [Assign Tag](class/assign-tag.md) for a single tag), or use **Set**.

Other useful nodes: [Make Tag](class/make-tag.md), [Make TagContainer](class/make-tagcontainer.md), [Get Tags](class/get-tags.md), [Tag Count](class/tag-count.md) and [Tag To String](class/tag-to-string.md).
