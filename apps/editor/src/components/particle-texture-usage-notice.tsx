import { TriangleAlertIcon } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import type { ParticleTextureUsageWarning } from "../lib/particle-texture-usage";
import { useTextureUsageFix } from "../lib/use-particle-texture-usage";
import { TextureUsageNotifications } from "./texture-usage-notifications";

/**
 * Details callout listing each Texture an emitter's Material samples that
 * WebGPU would reject, each with the one-click **Set Usage To Particle** fix
 * (or why it cannot apply), followed by the fixes' Undo notifications.
 * Renders nothing without either.
 */
export function ParticleTextureUsageNotice({
  warnings,
}: {
  warnings: readonly ParticleTextureUsageWarning[];
}) {
  const { rows, notifications } = useTextureUsageFix(warnings);
  return (
    <>
      {rows.length > 0 ? (
        <Alert className="m-2 w-auto" data-testid="particle-texture-usage-notice">
          <TriangleAlertIcon />
          <AlertTitle>Texture Needs Particle Usage</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {rows.map((row) => (
              <div key={row.textureGuid} className="flex flex-col items-start gap-1">
                <div>{row.message}</div>
                {row.action ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="pointer-coarse:min-h-11"
                    disabled={row.action.disabled}
                    onClick={row.action.onClick}
                    data-testid={`particle-texture-usage-fix-${row.textureGuid}`}
                  >
                    {row.action.label}
                  </Button>
                ) : null}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      <TextureUsageNotifications notifications={notifications} className="m-2" />
    </>
  );
}
