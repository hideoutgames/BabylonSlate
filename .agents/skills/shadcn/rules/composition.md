# Component composition

## Items inside their group

**Incorrect:**

```tsx
<SelectContent>
  <SelectItem value="apple">Apple</SelectItem>
</SelectContent>
```

**Correct:**

```tsx
<SelectContent>
  <SelectGroup>
    <SelectItem value="apple">Apple</SelectItem>
  </SelectGroup>
</SelectContent>
```

| Item | Group |
| --- | --- |
| `SelectItem`, `SelectLabel` | `SelectGroup` |
| `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSub` | `DropdownMenuGroup` |

## Overlays need a title

`DialogTitle`, `AlertDialogTitle` and `SheetTitle` are required for accessibility. Hide one with `className="sr-only"` when the design has no visible title.

```tsx
<DialogContent>
  <DialogHeader>
    <DialogTitle>Rename Asset</DialogTitle>
    <DialogDescription>Choose a new name.</DialogDescription>
  </DialogHeader>
</DialogContent>
```

## Full Card and Tabs composition

Use `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` and `CardFooter` instead of putting everything in `CardContent`. `TabsTrigger` always sits inside `TabsList`.

```tsx
<Tabs defaultValue="general">
  <TabsList>
    <TabsTrigger value="general">General</TabsTrigger>
  </TabsList>
  <TabsContent value="general">…</TabsContent>
</Tabs>
```

## Components instead of custom markup

| Instead of | Use |
| --- | --- |
| A styled callout `div` | `Alert` with `AlertTitle` and `AlertDescription` |
| Hand-built empty-state markup | `Empty` with `EmptyHeader`, `EmptyMedia`, `EmptyTitle`, `EmptyDescription` and `EmptyContent` |
| `<hr>` or `<div className="border-t">` | `Separator` |
| `<div className="animate-pulse">` | `Skeleton` |
| `<span className="rounded-full bg-…">` | `Badge` |
