import { useState } from "react";
import type { Icon } from "@phosphor-icons/react/dist/lib/types";
import { AndroidLogo } from "@phosphor-icons/react/AndroidLogo";
import { AppleLogo } from "@phosphor-icons/react/AppleLogo";
import { Globe } from "@phosphor-icons/react/Globe";
import { LinuxLogo } from "@phosphor-icons/react/LinuxLogo";
import { WindowsLogo } from "@phosphor-icons/react/WindowsLogo";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@haptic/ui/components/field";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { useProjectState } from "../context/document-context";
import { PACKAGING_TARGETS, type PackagingTarget } from "../lib/packaging-targets";
import { gameArchiveName, useGameExport } from "./use-game-export";

/** Platform marks from Phosphor; macOS and iOS share the Apple mark. Imported one by one so only these ship. */
const TARGET_ICONS: Record<PackagingTarget["id"], Icon> = {
  web: Globe,
  windows: WindowsLogo,
  linux: LinuxLogo,
  macos: AppleLogo,
  android: AndroidLogo,
  ios: AppleLogo,
};

const UNAVAILABLE = PACKAGING_TARGETS.filter((entry) => !entry.available);

/**
 * Settings → Packaging: pick a target platform and build a playable copy of
 * the project. What a package includes is set in Project Settings → Export.
 */
export function PackagingDialog({
  open,
  onOpenChange,
  onOpenExportSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenExportSettings: () => void;
}) {
  const { projectDocument } = useProjectState();
  const { busy, error, notice, packageWeb } = useGameExport(projectDocument);
  const [targetId, setTargetId] = useState<PackagingTarget["id"]>("web");
  const target = PACKAGING_TARGETS.find((entry) => entry.id === targetId) ?? PACKAGING_TARGETS[0]!;
  const projectName = projectDocument?.metadata.name ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="packaging-dialog">
        <DialogHeader>
          <DialogTitle>Packaging</DialogTitle>
          <DialogDescription>Build a playable copy of {projectName}.</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel id="packaging-platform-label">Platform</FieldLabel>
          <ToggleGroup
            variant="outline"
            className="grid w-full grid-cols-3 sm:grid-cols-6"
            aria-labelledby="packaging-platform-label"
            value={[target.id]}
            onValueChange={(value) => {
              const next = PACKAGING_TARGETS.find((entry) => entry.id === value[0]);
              if (next?.available) setTargetId(next.id);
            }}
          >
            {PACKAGING_TARGETS.map((entry) => {
              const Mark = TARGET_ICONS[entry.id];
              return (
                <ToggleGroupItem
                  key={entry.id}
                  value={entry.id}
                  disabled={busy || !entry.available}
                  aria-describedby={entry.available ? undefined : "packaging-unavailable"}
                  className="h-auto min-w-0 flex-col gap-1 px-1 py-2"
                  data-testid={`packaging-target-${entry.id}`}
                >
                  <Mark aria-hidden="true" />
                  {entry.label}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
          <FieldDescription>
            {target.description}
            {projectName ? ` Downloads ${gameArchiveName(projectName)}.` : ""}
          </FieldDescription>
          <FieldDescription id="packaging-unavailable">
            {UNAVAILABLE.map((entry) => entry.label).join(", ").replace(/, ([^,]*)$/, " and $1")} are not available yet.
          </FieldDescription>
        </Field>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Packaging Failed</AlertTitle>
            <AlertDescription data-testid="packaging-error">{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
        <DialogFooter>
          <Button variant="ghost" className="mr-auto" onClick={onOpenExportSettings}>
            Export Settings
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="packaging-package"
            disabled={busy || !projectDocument}
            onClick={() => void packageWeb()}
          >
            {busy ? "Packaging…" : "Package"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
