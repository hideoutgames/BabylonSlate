import { Component, type ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { SelectableText } from "@babylonslate/editor-kit";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
}

interface WorkspaceErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps editor chrome mounted when a document panel throws on render
 * (old scene payloads, stale DockView layouts).
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
          </AlertDescription>
        </Alert>
      );
    }
    return this.props.children;
  }
}
