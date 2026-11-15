import { useEffect, useRef, useState } from "react";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { isOk } from "@haptic/core";
import {
  completeDeviceSignIn,
  DEVICE_SIGN_IN_HOSTS,
  requestDeviceCode,
  systemDeviceClock,
  type DeviceCode,
  type DeviceSignInError,
  type DeviceSignInHost,
} from "@haptic/source-control/device-flow";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@haptic/ui/components/dialog";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { isTestModeEnabled } from "@haptic/vfs";
import { deviceClientId } from "../lib/source-control-client-ids";
import { sourceControlAccounts } from "../services/source-control-accounts";
import { ActionFeedbackButton } from "./action-feedback-button";

type SignInState =
  | { status: "requesting" }
  | { status: "waiting"; code: DeviceCode }
  | { status: "failed"; message: string };

function failureMessage(error: DeviceSignInError, label: string): string {
  if (error.kind === "expired") return "The code expired. Get a new code to try again.";
  if (error.kind === "denied") return `Access was denied on ${label}.`;
  if (error.kind === "offline") return `Could not reach ${label}. Check the connection.`;
  return error.message;
}

function remaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Sign In To GitHub / GitLab: shows the device code, opens the host's device
 * page in the system browser and waits for the approval, then saves the
 * credential on this device. Loaded only after the link warning is accepted.
 */
export default function SourceControlSignInDialog({
  host,
  onDone,
}: {
  host: DeviceSignInHost;
  /** True once the credential is saved; false on Cancel. */
  onDone: (linked: boolean) => void;
}) {
  const label = DEVICE_SIGN_IN_HOSTS[host].label;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SignInState>({ status: "requesting" });
  const [now, setNow] = useState(() => systemDeviceClock.now());
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const controller = new AbortController();
    const fail = (message: string) => {
      if (!controller.signal.aborted) setState({ status: "failed", message });
    };
    setState({ status: "requesting" });
    void (async () => {
      const testMode = isTestModeEnabled();
      const clientId = deviceClientId(host, testMode);
      const accounts = await sourceControlAccounts(testMode);
      if (!clientId || !accounts.http) {
        fail(`${label} sign-in is not available in this build.`);
        return;
      }
      const code = await requestDeviceCode(host, clientId, accounts.http, systemDeviceClock);
      if (controller.signal.aborted) return;
      if (!isOk(code)) {
        fail(failureMessage(code.error, label));
        return;
      }
      setNow(systemDeviceClock.now());
      setState({ status: "waiting", code: code.value });
      const credential = await completeDeviceSignIn(code.value, clientId, accounts.http, systemDeviceClock, controller.signal);
      if (controller.signal.aborted) return;
      if (!isOk(credential)) {
        fail(failureMessage(credential.error, label));
        return;
      }
      await accounts.save(credential.value);
      if (!controller.signal.aborted) done.current(true);
    })().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    return () => controller.abort();
  }, [attempt, host, label]);

  const waiting = state.status === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(systemDeviceClock.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(false); }}>
      <DialogContent className="sm:max-w-sm" data-testid="source-control-sign-in-dialog">
        <DialogHeader>
          <DialogTitle>Sign In To {label}</DialogTitle>
        </DialogHeader>
        {state.status === "waiting" ? (
          <>
            <Field>
              <FieldLabel htmlFor="source-control-device-code">Code</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="source-control-device-code"
                  data-testid="source-control-device-code"
                  readOnly
                  value={state.code.userCode}
                  className="h-12 flex-1 text-center font-mono text-2xl tracking-widest"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <ActionFeedbackButton
                  label="Copy"
                  icon={CopyIcon}
                  data-testid="source-control-device-code-copy"
                  onAction={() => navigator.clipboard.writeText(state.code.userCode)}
                >
                  Copy
                </ActionFeedbackButton>
              </div>
            </Field>
            <p className="text-sm text-muted-foreground" role="status" data-testid="source-control-sign-in-status">
              Waiting for approval. The code expires in {remaining(state.code.expiresAt, now)}.
            </p>
          </>
        ) : state.status === "requesting" ? (
          <p className="text-sm text-muted-foreground" role="status">Getting a code…</p>
        ) : (
          <Alert variant="destructive" data-testid="source-control-sign-in-error">
            <AlertTitle>Could Not Sign In</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" data-testid="source-control-sign-in-cancel" onClick={() => onDone(false)}>
            Cancel
          </Button>
          {state.status === "failed" ? (
            <Button data-testid="source-control-sign-in-retry" onClick={() => setAttempt((value) => value + 1)}>
              Try Again
            </Button>
          ) : (
            <Button
              data-testid="source-control-sign-in-open"
              disabled={!waiting}
              onClick={() => {
                if (state.status === "waiting") window.open(state.code.verificationUrl, "_blank", "noopener,noreferrer");
              }}
            >
              <ExternalLinkIcon data-icon="inline-start" />
              Open {label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
