import { SelectableText, PanelFrame, ToolbarStrip } from "@babylonslate/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
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

export function ComponentGallery() {
  return (
    <div
      className="flex min-h-svh h-dvh flex-col bg-background text-foreground"
      data-testid="component-gallery"
    >
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold">Component Gallery</h1>
        <p className="text-sm text-muted-foreground">
          Dev-only audit surface for Minimal Neutral and editor-kit composites.
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

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Feedback</h2>
            <Alert>
              <AlertTitle>Default alert</AlertTitle>
              <AlertDescription>Minimal Neutral surface tokens.</AlertDescription>
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
                <Button size="sm" variant="ghost">
                  Tool
                </Button>
              </ToolbarStrip>
              <PanelFrame title="Panel frame" data-testid="gallery-panel-frame">
                <p className="p-4 text-sm text-muted-foreground">
                  Docked panel body uses PanelFrame + ScrollArea in real panels.
                </p>
              </PanelFrame>
            </div>
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
