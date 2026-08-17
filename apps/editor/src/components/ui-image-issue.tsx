import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import {
  uiImageIssueMessage,
  type UiImageIssue,
} from "../lib/play-ui-images";

export function UiImageIssueAlert({
  issues,
}: {
  issues: readonly UiImageIssue[];
}) {
  if (issues.length === 0) return null;
  return (
    <Alert
      data-testid="ui-image-issue"
      className="pointer-events-none absolute inset-x-2 top-2 z-10"
    >
      <AlertTitle>Texture Unavailable</AlertTitle>
      <AlertDescription>
        {issues.map((issue) => uiImageIssueMessage(issue)).join(" ")}
      </AlertDescription>
    </Alert>
  );
}
