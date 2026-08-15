import { XIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";

export type PreviewBuildOverlayProps = {
  src: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onClose: () => void;
  onLoad?: () => void;
};

export function PreviewBuildOverlay({
  src,
  iframeRef,
  onClose,
  onLoad,
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
