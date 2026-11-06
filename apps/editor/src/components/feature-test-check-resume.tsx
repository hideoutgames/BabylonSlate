import { useEffect, useRef, useState } from "react";
import { Button } from "@haptic/ui/components/button";
import { useDocumentActions, useEditorShellState } from "../context/document-context";
import { hasBreakdownResumeMarker } from "../lib/feature-test-breakdown-marker";
import { FeatureTestCheckStatus } from "./feature-test-check-status";

/**
 * On Home once the project list loads: a Breakdown waiting for its second pass (after the A/B's reload) reopens its
 * project, where the check dialog resumes it; one that cannot resume says so, and its report waits in the dialog.
 * The A/B code, which brings the check's runner, loads only when a resume marker is stored.
 */
export function FeatureTestCheckResume() {
  const { openListedProject } = useDocumentActions();
  const { listedProjects, homepageReady } = useEditorShellState();
  const [status, setStatus] = useState<{ message: string; cancel: (() => void) | null } | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (!homepageReady || handled.current) return;
    handled.current = true;
    if (!hasBreakdownResumeMarker()) return;
    void Promise.all([import("../lib/feature-test-breakdown-ab"), import("../lib/feature-test-ab-deps")]).then(
      ([{ abandonSecondPass, resumeAfterLoad }, { FEATURE_TEST_AB_DEPS }]) => {
        const action = resumeAfterLoad(listedProjects, FEATURE_TEST_AB_DEPS);
        if (action.kind === "none") return;
        const abandoned = (reason: string, reported: boolean) => setStatus({
          message: `The Breakdown's second pass did not run: ${reason}.${reported ? " Its report is in Run Feature Test Check." : ""}`,
          cancel: null,
        });
        if (action.kind === "abandoned") {
          abandoned(action.reason, action.reported);
          return;
        }
        setStatus({
          message: `Reopening ${action.project.label} for the Breakdown's second pass`,
          cancel: () => abandonSecondPass(action.marker, "cancelled", FEATURE_TEST_AB_DEPS),
        });
        openListedProject(action.project).catch((error: unknown) => {
          const reason = `${action.project.label} did not reopen (${error instanceof Error ? error.message : String(error)})`;
          abandoned(abandonSecondPass(action.marker, reason, FEATURE_TEST_AB_DEPS), true);
        });
      },
      (error: unknown) => console.error("[editor] could not load the Feature Test Check resume", error),
    );
  }, [homepageReady, listedProjects, openListedProject]);

  if (!status) return null;
  const { cancel } = status;
  return (
    <FeatureTestCheckStatus message={status.message} action={cancel ? (
      <Button size="sm" variant="secondary" data-testid="feature-test-check-cancel" onClick={() => {
        cancel();
        setStatus(null);
      }}>
        Cancel
      </Button>
    ) : (
      <Button size="sm" variant="secondary" onClick={() => setStatus(null)}>Dismiss</Button>
    )} />
  );
}
