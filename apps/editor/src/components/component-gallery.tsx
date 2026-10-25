import { OctagonAlertIcon, SaveIcon } from "lucide-react";
import { useState } from "react";
import { TagGallery } from "./tag-gallery";
import { GalleryComposites } from "./component-gallery-composites";
import {
  CatalogDialog,
  ColorPicker,
  TimelineChart,
  type TimelineDomain,
  type TimelineSelection,
  type TimelineTrack,
  FolderBreadcrumbs,
  PanelFrame,
  SelectableText,
  ToolbarStrip,
} from "@haptic/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@haptic/ui/components/alert-dialog";
import { Badge } from "@haptic/ui/components/badge";
import { Button } from "@haptic/ui/components/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@haptic/ui/components/toggle-group";
import { Toggle } from "@haptic/ui/components/toggle";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@haptic/ui/components/card";
import { Checkbox } from "@haptic/ui/components/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@haptic/ui/components/resizable";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { Separator } from "@haptic/ui/components/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@haptic/ui/components/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@haptic/ui/components/sheet";
import { Skeleton } from "@haptic/ui/components/skeleton";
import { Slider } from "@haptic/ui/components/slider";
import { Switch } from "@haptic/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@haptic/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@haptic/ui/components/tooltip";

/** Deterministic samples: a 60 fps frame stream with a hitch, and ticks split into two parts. */
const GALLERY_TIMELINE_TIMES = Array.from({ length: 180 }, (_, index) => index * 16.7);
const GALLERY_TIMELINE_TRACKS: readonly TimelineTrack[] = [
  {
    id: "frames", label: "Frames", unit: "ms", times: GALLERY_TIMELINE_TIMES, threshold: 16.7,
    segments: [{ label: "Frame Time", color: "--trace-script",
      values: GALLERY_TIMELINE_TIMES.map((_, index) => index === 90 ? 42 : 15 + 2 * Math.sin(index / 7)) }],
  },
  {
    id: "ticks", label: "Ticks", unit: "ms", times: GALLERY_TIMELINE_TIMES, threshold: 8,
    segments: [
      { label: "Script", color: "--trace-script", values: GALLERY_TIMELINE_TIMES.map((_, index) => 3 + 1.5 * Math.sin(index / 9)) },
      { label: "Physics", color: "--trace-physics", values: GALLERY_TIMELINE_TIMES.map((_, index) => index === 90 ? 9 : 2 + Math.cos(index / 5)) },
    ],
  },
];

function GalleryTimelineChart() {
  const [selected, setSelected] = useState<TimelineSelection | null>({ track: "frames", index: 90 });
  const [range, setRange] = useState<TimelineDomain | null>(null);
  return (
    <section className="rounded-lg border border-border" data-testid="gallery-timeline-chart">
      <div className="px-3 pt-2 text-sm font-medium">Timeline Chart</div>
      <TimelineChart
        tracks={GALLERY_TIMELINE_TRACKS}
        markers={[{ atMs: 1000, endMs: 1300, label: "Loading", color: "--muted-foreground" }, { atMs: 2200, label: "Scene Changed", color: "--foreground" }]}
        domain={[0, 3000]}
        selected={selected}
        range={range}
        onSelect={setSelected}
        onRangeChange={setRange}
        aria-label="Example Timeline"
      />
    </section>
  );
}

function GalleryColorPickers() {
  const [rgba, setRgba] = useState<[number, number, number, number]>([0.9, 0.3, 0.1, 0.8]);
  const [rgb, setRgb] = useState<[number, number, number, number]>([0.2, 0.55, 0.85, 1]);
  return (
    <section className="flex flex-col gap-4" data-testid="gallery-color-picker">
      <h2 className="text-lg font-medium">Color Picker</h2>
      <FieldGroup className="grid gap-3 md:grid-cols-2">
        <Field>
          <FieldLabel>RGBA Color</FieldLabel>
          <ColorPicker value={rgba} onChange={setRgba} aria-label="RGBA Color" data-testid="gallery-color-picker-rgba" />
        </Field>
        <Field>
          <FieldLabel>RGB Color</FieldLabel>
          <ColorPicker value={rgb} withAlpha={false} onChange={setRgb} aria-label="RGB Color" data-testid="gallery-color-picker-rgb" />
        </Field>
      </FieldGroup>
    </section>
  );
}

function GalleryTouchControls() {
  const [tool, setTool] = useState("translate");
  const [statsOpen, setStatsOpen] = useState(false);
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
          <Toggle size="touch" variant="secondary" pressed={statsOpen} onPressedChange={setStatsOpen}>
            Stats
          </Toggle>
        </div>
        <p className="text-sm text-muted-foreground">
          Outline marks an action. Pressed tools retain a primary outline; secondary toggles stay filled in both states.
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

function GalleryForms() {
  const [volume, setVolume] = useState(0.5);

  return (
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
            <Field>
              <FieldLabel htmlFor="gallery-volume">Volume</FieldLabel>
              <Slider
                id="gallery-volume"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                data-testid="gallery-slider"
                onValueChange={(next) => {
                  const value = Array.isArray(next) ? next[0] : next;
                  if (typeof value === "number") setVolume(value);
                }}
              />
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
  );
}

function GalleryDangerDialog() {
  // Controlled like production callers: the Action is a plain button.
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant="outline" data-testid="gallery-danger-dialog-open" />
        }
      >
        Open Danger Dialog
      </AlertDialogTrigger>
      <AlertDialogContent
        variant="destructive"
        data-testid="gallery-danger-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogMedia data-testid="gallery-danger-dialog-media">
            <OctagonAlertIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete Items?</AlertDialogTitle>
          <AlertDialogDescription>
            This action is not undoable. The selected assets will be removed
            permanently.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="touch">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            size="touch"
            data-testid="gallery-danger-dialog-confirm"
            onClick={() => setOpen(false)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const GALLERY_LONG_ROWS = Array.from({ length: 40 }, (_, index) => `Setting ${index + 1}`);

/** Content taller than the viewport: only the body scrolls; Close stays pinned. */
function GalleryLongOverlays() {
  const rows = GALLERY_LONG_ROWS.map((label) => (
    <p key={label} className="text-sm">{label}</p>
  ));
  return (
    <div className="flex flex-wrap gap-2">
      <Dialog>
        <DialogTrigger render={<Button variant="outline" size="sm" data-testid="gallery-long-dialog-open" />}>Open Long Dialog</DialogTrigger>
        <DialogContent data-testid="gallery-long-dialog">
          <DialogHeader>
            <DialogTitle>Long Dialog</DialogTitle>
            <DialogDescription>The close button stays visible while this list scrolls.</DialogDescription>
          </DialogHeader>
          {rows}
          <p className="text-sm" data-testid="gallery-long-dialog-end">End of List</p>
        </DialogContent>
      </Dialog>
      <Sheet>
        <SheetTrigger render={<Button variant="outline" size="sm" data-testid="gallery-long-sheet-open" />}>Open Long Sheet</SheetTrigger>
        <SheetContent side="right" data-testid="gallery-long-sheet">
          <SheetHeader>
            <SheetTitle>Long Sheet</SheetTitle>
            <SheetDescription>The close button stays visible while this list scrolls.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4 pb-4">
            {rows}
            <p className="text-sm" data-testid="gallery-long-sheet-end">End of List</p>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function GalleryResizable() {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">Resizable Panels</h2>
      <p className="text-sm text-muted-foreground">
        Drag the divider or focus it and use the arrow keys to adjust both panels.
      </p>
      <div className="h-40 overflow-hidden rounded-lg border border-border">
        <ResizablePanelGroup orientation="horizontal" id="gallery-resizable">
          <ResizablePanel id="gallery-resizable-folders" defaultSize="35%" minSize="25%">
            <div className="flex h-full items-center justify-center text-sm">Folders</div>
          </ResizablePanel>
          <ResizableHandle
            id="gallery-resizable-divider"
            aria-label="Resize Folders And Assets"
            withHandle
          />
          <ResizablePanel id="gallery-resizable-assets" minSize="25%">
            <div className="flex h-full items-center justify-center text-sm">Assets</div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </section>
  );
}

export function ComponentGallery() {
  const [folderPath, setFolderPath] = useState("Content/Characters/Hero");
  return (
    <div
      className="flex min-h-svh h-dvh flex-col overflow-hidden bg-background text-foreground"
      data-testid="component-gallery"
    >
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold">Component Gallery</h1>
        <p className="text-sm text-muted-foreground">
          Dev-only audit surface for Graphite chrome tokens and editor-kit composites.
          Open with{" "}
          <SelectableText className="font-mono text-xs">
            ?test=1&amp;gallery=1
          </SelectableText>
          .
        </p>
      </header>
      <ScrollArea className="min-h-0 flex-1">
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
            <GalleryDangerDialog />
            <Sheet modal={false}>
              <SheetTrigger render={<Button variant="outline" size="sm" data-testid="gallery-console-sheet-open" />}>Open Console Sheet</SheetTrigger>
              <SheetContent side="bottom" showOverlay={false} className="rounded-none shadow-none data-[side=bottom]:h-[min(40dvh,22rem)] pointer-coarse:data-[side=bottom]:h-[min(50dvh,26rem)]" bodyClassName="gap-0" data-testid="gallery-console-sheet">
                <SheetHeader><SheetTitle>Console Sheet</SheetTitle></SheetHeader>
                <SelectableText className="px-4 font-mono text-xs">A flat nonmodal drawer leaves the view above visible and interactive.</SelectableText>
              </SheetContent>
            </Sheet>
            <GalleryLongOverlays />
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

          <GalleryForms />

          <GalleryColorPickers />
          <GalleryTimelineChart />

          <TagGallery />

          <GalleryResizable />

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
            <FolderBreadcrumbs
              root={{ path: "Content", label: "Content" }}
              path={folderPath}
              onNavigate={setFolderPath}
            />
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
