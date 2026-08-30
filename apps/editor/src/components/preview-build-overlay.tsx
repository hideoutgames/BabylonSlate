import { XIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { SelectableText } from "@babylonslate/editor-kit";

export type PreviewBuildOverlayProps = {
  src: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onClose: () => void;
  onLoad?: () => void;
  /** Boot failure reported by the player, so the black canvas is explained. */
  error?: string | null;
};

export function PreviewBuildOverlay({
  src,
  iframeRef,
  onClose,
  onLoad,
  error = null,
}: PreviewBuildOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      data-testid="preview-build-overlay"
    >
      <iframe
        ref={iframeRef}
        title="Preview Build"
        src={src}
        className="absolute inset-0 h-full w-full border-0 bg-black outline-none focus-visible:outline-none"
        data-testid="preview-build-iframe"
        onLoad={onLoad}
      />
      {error ? (
        <div
          className="safe-overlay-chrome absolute inset-x-0 top-16 z-20"
          style={{ "--safe-overlay-pad": "1rem" } as React.CSSProperties}
        >
          <Alert variant="destructive" data-testid="preview-build-error">
            <AlertTitle>Preview Build Failed To Start</AlertTitle>
            <AlertDescription>
              <SelectableText>{error}</SelectableText>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="safe-overlay-chrome pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-end">
        <Button
          size="touch"
          variant="secondary"
          className="pointer-events-auto"
          aria-label="Stop"
          data-testid="preview-build-close"
          onClick={onClose}
        >
          <XIcon data-icon="inline-start" />
          Stop
        </Button>
      </div>
    </div>
  );
}
