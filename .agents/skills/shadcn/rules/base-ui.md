# Base UI

Every primitive in `packages/ui` wraps `@base-ui/react`. Upstream examples written for Radix do not apply.

## Replacing an element: `render`

There is no `asChild`. Pass the element through `render` instead of wrapping it:

```tsx
<DialogTrigger render={<Button variant="outline" size="sm" />}>Open</DialogTrigger>
```

When `render` produces something other than a `<button>`, such as an `<a>` or `<span>`, add `nativeButton={false}`:

```tsx
<Button render={<a href="/docs" />} nativeButton={false}>
  Read the docs
</Button>
```

## Select

- `SelectValue` shows the raw value unless it has children or the root has `items`. Either render the label as children (`render-effects-fields.tsx`) or pass `items={[{ value, label }]}` and use `<SelectValue placeholder="…" />` (`scene-environment-panels.tsx`).
- A single-value `onValueChange` can receive `null`; check the value before using it.
- `SelectContent` defaults to `alignItemWithTrigger={false}`, so the popup opens below the trigger.
- `multiple`, object values with `itemToStringValue`, and a render function as `SelectValue` children are available when needed.

## ToggleGroup

There is no `type` prop. Selection is single by default; add `multiple` to allow several. `value` and `defaultValue` are always arrays:

```tsx
<ToggleGroup
  variant="outline"
  size="sm"
  spacing={0}
  value={[tool]}
  onValueChange={(value) => {
    const next = value[0];
    if (next) setTool(next);
  }}
>
```

## Slider

A single thumb accepts a number (`defaultValue={50}`); a range takes an array. `onValueChange` may receive either shape, so normalise it: `Array.isArray(value) ? value[0] : value` (`engine-settings-form.tsx`).

## Accordion

Accordion is not installed yet. When it is: there is no `type` or `collapsible`, `multiple` allows several open items, and `defaultValue` is an array (`<Accordion multiple defaultValue={["a", "b"]}>`).
