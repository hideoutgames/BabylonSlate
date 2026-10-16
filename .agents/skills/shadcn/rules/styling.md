# Styling

Token definitions are in [customization.md](../customization.md).

## Semantic colours, including status

**Incorrect:**

```tsx
<div className="bg-white text-gray-600 dark:bg-gray-950">…</div>
<span className="text-red-600">Failed</span>
<span className="text-amber-500">2 Warnings</span>
```

**Correct:**

```tsx
<div className="bg-background text-muted-foreground">…</div>
<span className="text-destructive">Failed</span>
<span className="text-(--warning)">2 Warnings</span>
```

If no token fits, ask before adding one to `tokens.css`.

## Variants first; `className` for layout

**Incorrect:**

```tsx
<Button className="border border-input bg-transparent hover:bg-accent">Apply</Button>
<Card className="bg-blue-100 font-bold">…</Card>
```

**Correct:**

```tsx
<Button variant="outline" size="sm">Apply</Button>
<Card className="mx-auto max-w-md">…</Card>
```

Change appearance with a built-in variant, then a semantic token, then a new token; never by overriding a component's colours or typography in `className`.

## Utility shorthands

- `size-6`, not `w-6 h-6`.
- `truncate`, not `overflow-hidden text-ellipsis whitespace-nowrap`.

## Conditional classes use `cn()`

**Incorrect:**

```tsx
<div className={`flex items-center ${active ? "bg-accent" : "bg-muted"}`}>
```

**Correct:**

```tsx
<div className={cn("flex items-center", active ? "bg-accent" : "bg-muted")}>
```

## No manual z-index on overlays

Dialog, AlertDialog, Sheet, DropdownMenu, Select and Tooltip manage their own stacking. Do not add `z-50` or `z-[999]`.
