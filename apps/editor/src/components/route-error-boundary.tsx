import { Component, type ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { SelectableText } from "@haptic/editor-kit";
import { releaseBootIntro } from "./boot-intro";

interface RouteErrorBoundaryState {
  error: Error | null;
}

/**
 * Replaces the whole app with a way out when a route cannot load, such as a
 * lazy chunk that failed to download. Sits outside the launcher transition so
 * its splash cover cannot hide the Reload action, and releases the boot intro,
 * which lives outside React.
 */
export class RouteErrorBoundary extends Component<
  { children: ReactNode },
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch() {
    releaseBootIntro();
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className="flex min-h-dvh items-center justify-center p-4"
        data-testid="route-error"
      >
        <Alert variant="destructive" className="max-w-sm">
          <AlertTitle>Couldn&apos;t Load Haptic</AlertTitle>
          <AlertDescription>
            <p>Something went wrong while loading. Reload to try again.</p>
            <p className="text-xs">
              <SelectableText>{error.message}</SelectableText>
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:min-h-11"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
}
