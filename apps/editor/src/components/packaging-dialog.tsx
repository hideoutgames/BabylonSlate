import { useEffect, useMemo, useState, type ComponentType } from "react";
import { DownloadIcon } from "lucide-react";
import SiHtml5 from "@icons-pack/react-simple-icons/icons/SiHtml5";
import Android from "react-bootstrap-icons/dist/icons/android";
import Apple from "react-bootstrap-icons/dist/icons/apple";
import Tux from "react-bootstrap-icons/dist/icons/tux";
import Windows from "react-bootstrap-icons/dist/icons/windows";
import { defaultExportPreset } from "@haptic/core";
import { resolvedAppIdentity } from "@haptic/core";
import { desktopGameNames, macGameNames } from "@haptic/exporter/native-desktop";
import { androidGameFileName, type AndroidPackageFormat } from "@haptic/exporter/native-android";
import { iosGameFileName, type IosPackageFormat } from "@haptic/exporter/native-ios";
import { getElectronGameShellBridge } from "@haptic/vfs";
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
import { useAppSettings } from "../context/app-settings-context";
import { useProjectState, useRegistryState } from "../context/document-context";
import { useAndroidPackaging } from "../lib/android-packaging";
import { packagingTargets, type PackagingTarget } from "../lib/packaging-targets";
import { gameArchiveName, useGameExport, useGameShells, type LinuxPackageFormat } from "./use-game-export";

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

function targetGroups(targets: readonly PackagingTarget[]) {
  return [
    { id: "available", label: "Available", targets: targets.filter((entry) => entry.available) },
    { id: "unavailable", label: "Unavailable", targets: targets.filter((entry) => !entry.available) },
  ].filter((group) => group.targets.length > 0);
}

/** Why a platform cannot be packaged here: a desktop player this copy of Haptic does not carry, or one not offered on this device. */
function unavailableReason(target: PackagingTarget): string {
  return target.desktopTarget
    ? `This copy of Haptic does not include the ${target.label} player.`
    : `${target.label} packaging is not available on this device.`;
}

function PlatformMark({ target, className }: { target: PackagingTarget; className?: string }) {
  const { Mark, color } = MARKS[target.id];
  // An empty title keeps the mark decorative: SiHtml5 otherwise adds an "HTML5" title to the label and a tooltip.
  return <Mark aria-hidden title="" className={cn("shrink-0", target.available ? color : "text-muted-foreground", className)} />;
}

/** This Mac's Xcode version, or why iOS games cannot be built here; read when `active` turns on. */
function useXcode(active: boolean): { version: string | null; problems: string[] } | null {
  const [xcode, setXcode] = useState<{ version: string | null; problems: string[] } | null>(null);
  useEffect(() => {
    const bridge = getElectronGameShellBridge();
    if (!active || !bridge?.iosToolchain) return;
    let current = true;
    void bridge.iosToolchain().then(
      (found) => { if (current) setXcode(found); },
      (error: unknown) => { if (current) setXcode({ version: null, problems: [error instanceof Error ? error.message : String(error)] }); },
    );
    return () => { current = false; };
  }, [active]);
  return xcode;
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
  const { assetRegistry, projectGuid } = useRegistryState();
  const shells = useGameShells(open);
  const bridge = getElectronGameShellBridge();
  const androidAvailable = Boolean(bridge?.packageAndroid);
  const iosAvailable = bridge?.platform === "darwin" && Boolean(bridge.packageIos);
  const targets = useMemo(() => packagingTargets(shells.desktop, { android: androidAvailable, ios: iosAvailable }),
    [shells.desktop, androidAvailable, iosAvailable]);
  const groups = useMemo(() => targetGroups(targets), [targets]);
  const { busy, stage, error, notice, packageTarget } = useGameExport(projectDocument, { manifest: shells.manifest, projectGuid });
  const [targetId, setTargetId] = useState<PackagingTarget["id"]>("web");
  const [linuxFormat, setLinuxFormat] = useState<LinuxPackageFormat>("deb");
  const [androidFormat, setAndroidFormat] = useState<AndroidPackageFormat>("apk");
  const [iosFormat, setIosFormat] = useState<IosPackageFormat>("app-store");
  const target = targets.find((entry) => entry.id === targetId) ?? targets[0]!;
  const android = useAndroidPackaging(open && target.id === "android" && target.available);
  const androidProblems = [...(android.status?.toolchain.problems ?? []), ...(android.error ? [android.error] : [])];
  const androidReady = android.status !== null && androidProblems.length === 0;
  const settings = projectDocument?.settings;
  const projectName = projectDocument?.metadata.name ?? "";
  const macSigning = useAppSettings().settings.macSigning;
  const appIdentity = settings ? resolvedAppIdentity(settings.appIdentity, projectName) : null;
  const placeholderAppId = !settings?.appIdentity.appId;
  const startupGuid = settings?.startupSceneGuid ?? null;
  const startupScene = startupGuid ? assetRegistry?.getByGuid(startupGuid) : undefined;
  const bundleDebugger = (settings?.exportPresets[0] ?? defaultExportPreset()).bundleDebugger;
  const xcode = useXcode(open && target.id === "ios" && target.available);
  const iosSigning = useAppSettings().settings.iosSigning;
  const missingIosIcon = iosFormat === "app-store" && !settings?.appIdentity.iconTextureGuid;
  const iosReady = xcode !== null && xcode.problems.length === 0 && Boolean(iosSigning.teamId) && !missingIosIcon;
  const canPackage = target.available && Boolean(projectDocument) && Boolean(startupScene) && !busy
    && (target.id !== "android" || androidReady) && (target.id !== "ios" || iosReady);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" bodyClassName="flex flex-col gap-0 p-0" data-testid="packaging-dialog">
        <DialogHeader className="px-4 pt-4 pb-3">
          <DialogTitle>Packaging</DialogTitle>
          <DialogDescription>Build a playable copy of {projectName}.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-72 grid-cols-[11.5rem_minmax(0,1fr)] border-y max-sm:grid-cols-1">
          <nav aria-label="Platforms" className="flex flex-col gap-3 border-r bg-sidebar p-2 max-sm:border-r-0 max-sm:border-b">
            {groups.map((group) => (
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
                    const next = targets.find((entry) => entry.id === value[0]);
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
                    <dd className="truncate font-mono text-xs" data-testid="packaging-output">
                      {!projectName ? "" : target.id === "android"
                        ? androidGameFileName(appIdentity?.displayName ?? projectName, androidFormat)
                        : target.id === "ios"
                        ? iosGameFileName(appIdentity?.displayName ?? projectName, iosFormat)
                        : target.desktopTarget === "macos-arm64"
                        ? macGameNames(appIdentity?.displayName ?? projectName).archive
                        : target.desktopTarget
                          ? desktopGameNames(projectName, target.desktopTarget).archive.replace(/\.zip$/, target.id === "linux" && linuxFormat === "deb" ? ".deb" : ".zip")
                          : gameArchiveName(projectName)}
                    </dd>
                  </div>
                  {target.id === "linux" ? (
                    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                      <dt id="packaging-linux-format" className="text-muted-foreground">Format</dt>
                      <dd>
                        <ToggleGroup
                          aria-labelledby="packaging-linux-format"
                          value={[linuxFormat]}
                          disabled={busy}
                          onValueChange={(value) => {
                            if (value[0] === "deb" || value[0] === "zip") setLinuxFormat(value[0]);
                          }}
                        >
                          <ToggleGroupItem value="deb" data-testid="packaging-linux-deb">Debian Package</ToggleGroupItem>
                          <ToggleGroupItem value="zip" data-testid="packaging-linux-zip">ZIP</ToggleGroupItem>
                        </ToggleGroup>
                      </dd>
                    </div>
                  ) : null}
                  {target.id === "android" ? (
                    <>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt id="packaging-android-format" className="text-muted-foreground">Format</dt>
                        <dd>
                          <ToggleGroup
                            aria-labelledby="packaging-android-format"
                            value={[androidFormat]}
                            disabled={busy}
                            onValueChange={(value) => {
                              if (value[0] === "apk" || value[0] === "aab") setAndroidFormat(value[0]);
                            }}
                          >
                            <ToggleGroupItem value="apk" data-testid="packaging-android-apk">APK</ToggleGroupItem>
                            <ToggleGroupItem value="aab" data-testid="packaging-android-aab">App Bundle</ToggleGroupItem>
                          </ToggleGroup>
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">App ID</dt>
                        <dd className={cn("truncate font-mono text-xs", placeholderAppId && "text-(--warning)")} data-testid="packaging-app-id">{appIdentity?.appId}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">Signing</dt>
                        <dd className="truncate font-medium" data-testid="packaging-android-signing">
                          {android.status?.keystore ? android.status.alias || "No Key Alias" : "Debug Key (Testing Only)"}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">Build Tools</dt>
                        <dd className={cn("truncate font-medium", androidProblems.length > 0 && "text-(--warning)")} data-testid="packaging-android-toolchain">
                          {android.status === null && !android.error ? "Checking…" : androidReady ? `Java ${android.status!.toolchain.javaVersion}, Android SDK` : "Not Found"}
                        </dd>
                      </div>
                    </>
                  ) : null}
                  {target.id === "ios" ? (
                    <>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt id="packaging-ios-format" className="text-muted-foreground">Format</dt>
                        <dd>
                          <ToggleGroup
                            aria-labelledby="packaging-ios-format"
                            value={[iosFormat]}
                            disabled={busy}
                            onValueChange={(value) => {
                              if (value[0] === "app-store" || value[0] === "development") setIosFormat(value[0]);
                            }}
                          >
                            <ToggleGroupItem value="app-store" data-testid="packaging-ios-app-store">App Store</ToggleGroupItem>
                            <ToggleGroupItem value="development" data-testid="packaging-ios-development">Development</ToggleGroupItem>
                          </ToggleGroup>
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">App ID</dt>
                        <dd className={cn("truncate font-mono text-xs", placeholderAppId && "text-(--warning)")} data-testid="packaging-app-id">{appIdentity?.appId}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">Team</dt>
                        <dd className={cn("truncate font-mono text-xs", !iosSigning.teamId && "text-(--warning)")} data-testid="packaging-ios-team">
                          {iosSigning.teamId || "Not Set"}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">Xcode</dt>
                        <dd className={cn("truncate font-medium", (xcode?.problems.length ?? 0) > 0 && "text-(--warning)")} data-testid="packaging-ios-xcode">
                          {xcode === null ? "Checking…" : xcode.version && xcode.problems.length === 0 ? xcode.version : "Not Ready"}
                        </dd>
                      </div>
                    </>
                  ) : null}
                  {target.id === "macos" ? (
                    <>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">App ID</dt>
                        <dd className={cn("truncate font-mono text-xs", placeholderAppId && "text-(--warning)")} data-testid="packaging-app-id">{appIdentity?.appId}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">Signing</dt>
                        <dd className="truncate font-medium" data-testid="packaging-mac-signing">
                          {macSigning.identity ? macSigning.identity.replace(/^Developer ID Application: /, "") : "Ad-Hoc (This Mac Only)"}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <dt className="text-muted-foreground">Notarization</dt>
                        <dd className="truncate font-medium" data-testid="packaging-mac-notarization">
                          {macSigning.identity && macSigning.notaryProfile ? macSigning.notaryProfile : "Off"}
                        </dd>
                      </div>
                    </>
                  ) : null}
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
                {target.id === "android" && androidProblems.length > 0 ? (
                  <Alert data-testid="packaging-android-problems">
                    <AlertTitle>Set Up Android Build Tools</AlertTitle>
                    <AlertDescription>{androidProblems.join(" ")}</AlertDescription>
                  </Alert>
                ) : null}
                {target.id === "ios" && xcode && xcode.problems.length > 0 ? (
                  <Alert data-testid="packaging-ios-problems">
                    <AlertTitle>Set Up Xcode</AlertTitle>
                    <AlertDescription>{xcode.problems.join(" ")}</AlertDescription>
                  </Alert>
                ) : null}
                {target.id === "ios" && !iosSigning.teamId ? (
                  <Alert data-testid="packaging-ios-team-missing">
                    <AlertTitle>Set Your Apple Team</AlertTitle>
                    <AlertDescription>Enter your Team ID in Engine Settings &gt; Packaging, and sign in to Xcode with your Apple account.</AlertDescription>
                  </Alert>
                ) : null}
                {target.id === "ios" && missingIosIcon ? (
                  <Alert data-testid="packaging-ios-icon-missing">
                    <AlertTitle>Set an App Icon</AlertTitle>
                    <AlertDescription>The App Store needs one.</AlertDescription>
                    <AlertAction>
                      <Button variant="outline" size="sm" onClick={() => onOpenProjectSettings("export")}>
                        Export Settings
                      </Button>
                    </AlertAction>
                  </Alert>
                ) : null}
                {(target.id === "macos" || target.id === "android" || target.id === "ios") && placeholderAppId ? (
                  <Alert data-testid="packaging-app-id-placeholder">
                    <AlertTitle>Set an App ID</AlertTitle>
                    <AlertDescription>The app uses a placeholder ID until you set one.</AlertDescription>
                    <AlertAction>
                      <Button variant="outline" size="sm" onClick={() => onOpenProjectSettings("export")}>
                        Export Settings
                      </Button>
                    </AlertAction>
                  </Alert>
                ) : null}
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
                    <p className="text-xs text-muted-foreground">Packaging… {stage}</p>
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
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground" data-testid="packaging-unavailable">
                {unavailableReason(target)}
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
          <Button data-testid="packaging-package" disabled={!canPackage} onClick={() => void packageTarget(target, { linuxFormat, macSigning, androidFormat, iosFormat, iosSigning })}>
            {busy ? null : <DownloadIcon data-icon="inline-start" />}
            {busy ? "Packaging…" : "Package"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
