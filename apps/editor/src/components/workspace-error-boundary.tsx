import { Component, type ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@haptic/ui/components/alert";
import { SelectableText } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { ChunkLoadError, reloadForNewBuild } from "../lib/preload-error-reload";
import { profileRegion } from "../lib/render-profile";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
  /** Editor-edit profiling region for this document subtree (test builds only). */
  renderProfileId?: string;
}

interface WorkspaceErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps editor chrome mounted when a document panel throws on render
 * (old scene payloads, stale DockView layouts). A `ChunkLoadError` (an
 * asset-editor family that didn't load) also gets Reload Editor.
 */
export class WorkspaceErrorBoundary extends Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  state: WorkspaceErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error };
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <Alert
          variant="destructive"
          className="m-4"
          data-testid="workspace-error"
        >
          <AlertTitle>Couldn&apos;t Open Document</AlertTitle>
          <AlertDescription>
            <SelectableText>{error.message}</SelectableText>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => this.setState({ error: null })}
              >
                Retry
              </Button>
              {error instanceof ChunkLoadError ? (
                // A newer deploy may have replaced the chunk, which no Retry can fetch.
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => reloadForNewBuild()}
                >
                  Reload Editor
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      );
    }
    const { children, renderProfileId } = this.props;
    return renderProfileId ? profileRegion(renderProfileId, children) : children;
  }
}
