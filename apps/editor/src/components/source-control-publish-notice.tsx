import { CircleAlertIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { useDocumentActions, useEditorShellState } from "../context/document-context";

/**
 * Why a Remote New Project opened as a Local one (no repository was created
 * or published), above the documents until dismissed or the project closes,
 * with where Publish is. A failed first push shows in the status bar instead.
 */
export function SourceControlPublishNotice() {
  const { publishNotice } = useEditorShellState();
  const { dismissPublishNotice } = useDocumentActions();
  if (!publishNotice) return null;
  return (
    <Alert role="status" className="shrink-0 rounded-none border-x-0 border-t-0" data-testid="source-control-publish-notice">
      <CircleAlertIcon />
      <AlertTitle>Created As A Local Project</AlertTitle>
      <AlertDescription>
        {publishNotice.message} To put it on a Git host, choose Publish Project in Project Settings &gt; Source Control.
      </AlertDescription>
      <AlertAction>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="pointer-coarse:min-h-11"
          data-testid="source-control-publish-notice-dismiss"
          onClick={dismissPublishNotice}
        >
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}
