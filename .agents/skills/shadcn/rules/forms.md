# Forms and inputs

## FieldGroup and Field

**Incorrect:**

```tsx
<div className="space-y-4">
  <Label htmlFor="name">Name</Label>
  <Input id="name" />
</div>
```

**Correct:**

```tsx
<FieldGroup>
  <Field>
    <FieldLabel htmlFor="name">Name</FieldLabel>
    <Input id="name" />
  </Field>
</FieldGroup>
```

Settings rows use `Field orientation="horizontal"`. Related checkboxes or switches go in a `FieldSet` with a `FieldLegend`, not a `div` with a heading.

## Option sets use ToggleGroup

**Incorrect:**

```tsx
{modes.map((mode) => (
  <Button key={mode} variant={mode === selected ? "default" : "outline"} onClick={() => setSelected(mode)}>
    {mode}
  </Button>
))}
```

**Correct:**

```tsx
<ToggleGroup variant="outline" size="sm" spacing={0} value={[selected]} onValueChange={(v) => v[0] && setSelected(v[0])}>
  {modes.map((mode) => (
    <ToggleGroupItem key={mode} value={mode}>{mode}</ToggleGroupItem>
  ))}
</ToggleGroup>
```

Value handling is in [base-ui.md](base-ui.md#togglegroup).

## Invalid and disabled states

Set both attributes: the `data-*` attribute styles the field's label and description, and the control attribute styles the control.

```tsx
<Field data-invalid>
  <FieldLabel htmlFor="name">Name</FieldLabel>
  <Input id="name" aria-invalid />
  <FieldError>Name is required.</FieldError>
</Field>

<Field data-disabled>
  <FieldLabel htmlFor="path">Path</FieldLabel>
  <Input id="path" disabled />
</Field>
```

This applies to `Input`, `Textarea`, `Select`, `Checkbox`, `Switch` and `Slider`.
