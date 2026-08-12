import { SaveIcon } from "lucide-react";
import { useState } from "react";
import {
  AssetPicker,
  CatalogDialog,
  NumericDragField,
  PanelFrame,
  PropertyGrid,
  SearchSheet,
  SelectableText,
  ToolbarStrip,
  TreeView,
  type PropertyRow,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Separator } from "@babylonslate/ui/components/separator";
import { Skeleton } from "@babylonslate/ui/components/skeleton";
import { Switch } from "@babylonslate/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@babylonslate/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";

const GALLERY_TREE_NODES: TreeViewNode[] = [
  { id: "root", label: "Scene Root", depth: 0, hasChildren: true, expanded: true },
  { id: "player", label: "Player", depth: 1, hasChildren: false, expanded: false },
  { id: "ground", label: "Ground", depth: 1, hasChildren: false, expanded: false },
];

function GalleryComposites() {
  const [position, setPosition] = useState<[number, number, number]>([0, 1, 0]);
  const [speed, setSpeed] = useState(4);
  const [visible, setVisible] = useState(true);
  const [selectedId, setSelectedId] = useState("player");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const rows: PropertyRow[] = [
    {
      kind: "vector3",
      id: "gallery-position",
      label: "Position",
      value: position,
      defaultValue: [0, 0, 0],
      onChange: setPosition,
    },
    {
      kind: "number",
      id: "gallery-speed",
      label: "Speed",
      value: speed,
      defaultValue: 4,
      sensitivity: 0.05,
      onChange: setSpeed,
    },
    {
      kind: "boolean",
      id: "gallery-visible",
      label: "Visible",
      value: visible,
      defaultValue: true,
      onChange: setVisible,
    },
    {
      kind: "enum",
      id: "gallery-mode",
      label: "Viewport Mode",
      value: "3d",
      options: [
        { value: "3d", label: "3D" },
        { value: "2d", label: "2D" },
      ],
      onChange: () => {},
    },
    {
      kind: "asset",
      id: "gallery-mesh",
      label: "Mesh",
      value: null,
      placeholder: "None",
      onPick: () => setPickerOpen(true),
      onChange: () => {},
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border">
        <PanelFrame title="Property grid" data-testid="gallery-property-grid">
          <PropertyGrid rows={rows} />
        </PanelFrame>
      </div>
      <div className="h-40 overflow-hidden rounded-lg border border-border">
        <PanelFrame title="Tree view" data-testid="gallery-tree-view">
          <TreeView
            nodes={GALLERY_TREE_NODES}
            selectedId={selectedId}
            onSelect={setSelectedId}
            data-testid="gallery-tree"
          />
        </PanelFrame>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <NumericDragField
            label="Drag"
            value={speed}
            onChange={setSpeed}
            data-testid="gallery-numeric-drag"
          />
        </div>
        <Button variant="outline" onClick={() => setSearchOpen(true)}>
          Open search sheet
        </Button>
        <Button variant="outline" onClick={() => setPickerOpen(true)}>
          Open asset picker
        </Button>
      </div>
      <SearchSheet
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Add component"
        items={[
          { id: "mesh", label: "MeshComponent", description: "Renderable mesh" },
          { id: "camera", label: "CameraComponent", description: "Scene camera" },
        ]}
        onSelect={() => {}}
        data-testid="gallery-search-sheet"
      />
      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={[{ guid: "gallery-asset", name: "Rock", type: "Mesh" }]}
        onPick={() => {}}
        data-testid="gallery-asset-picker"
      />
    </div>
  );
}

function GalleryTouchControls() {
  const [tool, setTool] = useState("translate");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [category, setCategory] = useState("appearance");
  const [search, setSearch] = useState("");

  return (
    <>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Touch actions</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="touch" variant="outline" data-testid="gallery-touch-button">
            Outline action
          </Button>
          <Button size="touch-icon" variant="outline" aria-label="Save">
            <SaveIcon />
          </Button>
          <ToggleGroup
            variant="outline"
            size="touch"
            spacing={1}
            value={[tool]}
            onValueChange={(value) => {
              if (value[0]) setTool(value[0]);
            }}
            aria-label="Gizmo tool"
            data-testid="gallery-toggle-group"
          >
            <ToggleGroupItem value="translate">Move</ToggleGroupItem>
            <ToggleGroupItem value="rotate">Rotate</ToggleGroupItem>
            <ToggleGroupItem value="scale">Scale</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <p className="text-sm text-muted-foreground">
          Outline marks an action. Toggle fill (`aria-pressed`) marks the active tool.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Settings catalog</h2>
        <Button
          size="touch"
          variant="outline"
          data-testid="gallery-open-catalog"
          onClick={() => setCatalogOpen(true)}
        >
          Open grouped catalog
        </Button>
        <CatalogDialog
          open={catalogOpen}
          onOpenChange={setCatalogOpen}
          title="Engine Settings"
          description="Search is not autofocused so iPad does not raise the keyboard."
          categories={[
            { id: "appearance", label: "Appearance" },
            { id: "viewport", label: "Viewport" },
            { id: "templates", label: "Templates" },
          ]}
          groups={[
            { label: "Rendering", ids: ["appearance", "viewport"] },
            { label: "Project", ids: ["templates"] },
          ]}
          activeCategoryId={category}
          onCategoryChange={setCategory}
          search={search}
          onSearchChange={setSearch}
          data-testid="gallery-catalog"
        >
          <p className="text-sm text-muted-foreground">
            Project Settings and Engine Settings are separate catalog modals.
          </p>
        </CatalogDialog>
        <p
          className="text-sm text-muted-foreground"
          data-testid="gallery-prefab-tab-note"
        >
          Class documents show Prefab as a full-size center-group tab beside Graph,
          not a 160px sidebar strip. The Components tree stays in the left dock.
        </p>
      </section>
    </>
  );
}

export function ComponentGallery() {
  return (
    <div
      className="flex min-h-svh h-dvh flex-col bg-background text-foreground"
      data-testid="component-gallery"
    >
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold">Component Gallery</h1>
        <p className="text-sm text-muted-foreground">
          Dev-only audit surface for Neutral chrome tokens and editor-kit composites.
          Open with{" "}
          <SelectableText className="font-mono text-xs">
            ?test=1&amp;gallery=1
          </SelectableText>
          .
        </p>
      </header>
      <ScrollArea className="flex-1">
        <div className="mx-auto flex max-w-4xl flex-col gap-8 p-6">
          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Actions</h2>
            <div className="flex flex-wrap gap-2">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
            </div>
          </section>

          <GalleryTouchControls />

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Feedback</h2>
            <Alert>
              <AlertTitle>Default alert</AlertTitle>
              <AlertDescription>Layered charcoal surface tokens.</AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge className="bg-vector text-background">Vector</Badge>
            </div>
            <Skeleton className="h-10 w-full max-w-sm" />
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyTitle>Empty state</EmptyTitle>
                <EmptyDescription>No items to show.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Forms</h2>
            <Card>
              <CardHeader>
                <CardTitle>Field group</CardTitle>
                <CardDescription>Engine Settings field pattern.</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="gallery-name">Name</FieldLabel>
                    <Input id="gallery-name" defaultValue="Sample" />
                  </Field>
                  <Field orientation="horizontal">
                    <Switch id="gallery-switch" defaultChecked />
                    <FieldLabel htmlFor="gallery-switch">Enabled</FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox id="gallery-check" defaultChecked />
                    <FieldLabel htmlFor="gallery-check">Generate thumbnails</FieldLabel>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Tabs</h2>
            <Tabs defaultValue="general">
              <TabsList>
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="rendering">Rendering</TabsTrigger>
              </TabsList>
              <TabsContent value="general" className="pt-4 text-sm text-muted-foreground">
                General settings content
              </TabsContent>
              <TabsContent value="rendering" className="pt-4 text-sm text-muted-foreground">
                Rendering settings content
              </TabsContent>
            </Tabs>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Tooltip</h2>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="outline" data-testid="gallery-tooltip-trigger" />}
              >
                Hover or focus
              </TooltipTrigger>
              <TooltipContent>Tooltip content</TooltipContent>
            </Tooltip>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">editor-kit composites</h2>
            <div className="overflow-hidden rounded-lg border border-border">
              <ToolbarStrip data-testid="gallery-toolbar-strip">
                <Button size="touch-icon" variant="outline" aria-label="Move">
                  Move
                </Button>
                <Separator orientation="vertical" className="h-8" />
                <Button size="touch" variant="outline">
                  Snap
                </Button>
              </ToolbarStrip>
              <PanelFrame title="Panel frame" data-testid="gallery-panel-frame">
                <p className="p-4 text-sm text-muted-foreground">
                  Docked panel body uses PanelFrame + ScrollArea in real panels.
                </p>
              </PanelFrame>
            </div>
            <GalleryComposites />
          </section>

          <Separator />
          <p className="text-xs text-muted-foreground">
            Touch-target minimum: <code>var(--touch-target)</code> (
            <span data-testid="gallery-touch-target-token">44px</span>)
          </p>
        </div>
      </ScrollArea>
    </div>
  );
}
