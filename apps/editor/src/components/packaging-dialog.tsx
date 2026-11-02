import { useState, type ComponentType } from "react";
import { DownloadIcon } from "lucide-react";
import SiHtml5 from "@icons-pack/react-simple-icons/icons/SiHtml5";
import Android from "react-bootstrap-icons/dist/icons/android";
import Apple from "react-bootstrap-icons/dist/icons/apple";
import Tux from "react-bootstrap-icons/dist/icons/tux";
import Windows from "react-bootstrap-icons/dist/icons/windows";
import { defaultExportPreset } from "@haptic/core";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { Progress } from "@haptic/ui/components/progress";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import { useProjectState, useRegistryState } from "../context/document-context";
import { PACKAGING_TARGETS, type PackagingTarget } from "../lib/packaging-targets";
import { gameArchiveName, useGameExport } from "./use-game-export";

type MarkProps = { className?: string; title?: string; "aria-hidden"?: boolean };

/**
 * Platform marks: Bootstrap Icons, and Simple Icons' HTML5 shield for Web
 * (Bootstrap Icons has none). Each is imported from its own module. macOS and
 * iOS share the Apple mark. Brand colours come from the `--platform-*` tokens;
 * Apple and Linux use the text colour.
 */
const MARKS: Record<PackagingTarget["id"], { Mark: ComponentType<MarkProps>; color?: string }> = {
  web: { Mark: SiHtml5, color: "text-platform-web" },
  windows: { Mark: Windows, color: "text-platform-windows" },
  linux: { Mark: Tux },
  macos: { Mark: Apple },
  android: { Mark: Android, color: "text-platform-android" },
  ios: { Mark: Apple },
};

const GROUPS = [
  { id: "available", label: "Available", targets: PACKAGING_TARGETS.filter((entry) => entry.available) },
  { id: "unavailable", label: "Unavailable", targets: PACKAGING_TARGETS.filter((entry) => !entry.available) },
].filter((group) => group.targets.length > 0);

function PlatformMark({ target, className }: { target: PackagingTarget; className?: string }) {
  const { Mark, color } = MARKS[target.id];
  // An empty title keeps the mark decorative: SiHtml5 otherwise adds an "HTML5" title to the label and a tooltip.
  return <Mark aria-hidden title="" className={cn("shrink-0", target.available ? color : "text-muted-foreground", className)} />;
}

function folderCount(count: number): string {
  if (count === 0) return "None";
  return count === 1 ? "1 Folder" : `${count} Folders`;
}

/**
 * Settings → Packaging: a platform list grouped into Available and Unavailable
 * beside the selected platform's details and what its package will contain.
 * What a package includes is set in Project Settings → Export.
 */
export function PackagingDialog({
  open,
  onOpenChange,
  onOpenProjectSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens Project Settings at a category: Export for packaging options, Game for the Startup Scene. */
  onOpenProjectSettings: (categoryId: "export" | "game") => void;
}) {
  const { projectDocument } = useProjectState();
  const { assetRegistry } = useRegistryState();
  const { busy, error, notice, packageWeb } = useGameExport(projectDocument);
  const [targetId, setTargetId] = useState<PackagingTarget["id"]>("web");
  const target = PACKAGING_TARGETS.find((entry) => entry.id === targetId) ?? PACKAGING_TARGETS[0]!;
  const settings = projectDocument?.settings;
  const projectName = projectDocument?.metadata.name ?? "";
  const startupGuid = settings?.startupSceneGuid ?? null;
  const startupScene = startupGuid ? assetRegistry?.getByGuid(startupGuid) : undefined;
  const bundleDebugger = (settings?.exportPresets[0] ?? defaultExportPreset()).bundleDebugger;
  const canPackage = target.available && Boolean(projectDocument) && Boolean(startupScene) && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" bodyClassName="flex flex-col gap-0 p-0" data-testid="packaging-dialog">
        <DialogHeader className="px-4 pt-4 pb-3">
          <DialogTitle>Packaging</DialogTitle>
          <DialogDescription>Build a playable copy of {projectName}.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-72 grid-cols-[11.5rem_minmax(0,1fr)] border-y max-sm:grid-cols-1">
          <nav aria-label="Platforms" className="flex flex-col gap-3 border-r bg-sidebar p-2 max-sm:border-r-0 max-sm:border-b">
            {GROUPS.map((group) => (
              <div key={group.id} className="flex flex-col gap-0.5">
                <p id={`packaging-group-${group.id}`} className="px-2 pt-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </p>
                <ToggleGroup
                  orientation="vertical"
                  className="w-full"
                  aria-labelledby={`packaging-group-${group.id}`}
                  value={group.targets.some((entry) => entry.id === target.id) ? [target.id] : []}
                  onValueChange={(value) => {
                    const next = PACKAGING_TARGETS.find((entry) => entry.id === value[0]);
                    if (next) setTargetId(next.id);
                  }}
                >
                  {group.targets.map((entry) => (
                    <ToggleGroupItem
                      key={entry.id}
                      value={entry.id}
                      disabled={busy}
                      className={cn("w-full justify-start gap-2.5 px-2", !entry.available && "text-muted-foreground")}
                      data-testid={`packaging-target-${entry.id}`}
                    >
                      <PlatformMark target={entry} className="size-4" />
                      {entry.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ))}
          </nav>
          <div className="flex min-w-0 flex-col gap-3 p-4" data-testid="packaging-detail">
            <div className="flex items-center gap-3">
              <span className="grid size-12 shrink-0 place-items-center rounded-xl border bg-muted">
                <PlatformMark target={target} className="size-7" />
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <h3 className="text-sm font-semibold">{target.label}</h3>
                <p className="text-xs text-muted-foreground">{target.description}</p>
              </div>
            </div>
            {target.available ? (
              <>
                <dl className="divide-y rounded-lg border bg-card text-sm" data-testid="packaging-summary">
                  <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <dt className="text-muted-foreground">Output</dt>
                    <dd className="truncate font-mono text-xs">{projectName ? gameArchiveName(projectName) : ""}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <dt className="text-muted-foreground">Startup Scene</dt>
                    <dd className={cn("truncate font-medium", !startupScene && "text-(--warning)")}>
                      {startupScene ? startupScene.header.name : startupGuid ? "Missing" : "Not Set"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <dt className="text-muted-foreground">Bundle Debugger</dt>
                    <dd className="font-medium">{bundleDebugger ? "On" : "Off"}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <dt className="text-muted-foreground">Always Package Folders</dt>
                    <dd className="font-medium">{folderCount(settings?.alwaysPackageFolders.length ?? 0)}</dd>
                  </div>
                </dl>
                {!startupScene ? (
                  <Alert data-testid="packaging-startup-scene">
                    <AlertTitle>Set a Startup Scene</AlertTitle>
                    <AlertDescription>Packaged games start there.</AlertDescription>
                    <AlertAction>
                      <Button variant="outline" size="sm" onClick={() => onOpenProjectSettings("game")}>
                        Game Settings
                      </Button>
                    </AlertAction>
                  </Alert>
                ) : null}
                {busy ? (
                  <div className="flex flex-col gap-1.5" role="status">
                    <Progress value={null} aria-label="Packaging" />
                    <p className="text-xs text-muted-foreground">Packaging… Collecting the assets the game reaches.</p>
                  </div>
                ) : null}
                {error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Packaging Failed</AlertTitle>
                    <AlertDescription data-testid="packaging-error">{error}</AlertDescription>
                  </Alert>
                ) : null}
                {notice && !busy ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
              </>
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                {target.label} packaging is not available on this device.
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="m-0 px-4 py-3">
          <Button variant="ghost" className="mr-auto" onClick={() => onOpenProjectSettings("export")}>
            Export Settings
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {notice && !busy ? "Close" : "Cancel"}
          </Button>
          <Button data-testid="packaging-package" disabled={!canPackage} onClick={() => void packageWeb()}>
            {busy ? null : <DownloadIcon data-icon="inline-start" />}
            {busy ? "Packaging…" : "Package"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
