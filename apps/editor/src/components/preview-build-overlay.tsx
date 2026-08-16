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
      className="fixed inset-0 z-50 flex flex-col bg-black"
      data-testid="preview-build-overlay"
    >
      <div className="flex h-[var(--chrome-row,28px)] items-center justify-end px-2">
        <Button
          size="sm"
          variant="ghost"
          className="chrome-icon-button"
          aria-label="Close"
          data-testid="preview-build-close"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {error ? (
        <div className="p-4">
          <Alert variant="destructive" data-testid="preview-build-error">
            <AlertTitle>Preview Build Failed To Start</AlertTitle>
            <AlertDescription>
              <SelectableText>{error}</SelectableText>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        title="Preview Build"
        src={src}
        className="min-h-0 flex-1 border-0 bg-black"
        data-testid="preview-build-iframe"
        onLoad={onLoad}
      />
    </div>
  );
}
