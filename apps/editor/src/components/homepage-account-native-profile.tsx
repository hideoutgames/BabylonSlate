import { useEffect, useRef, useState } from "react";
import { ImagePlusIcon, LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { getHostPlatform } from "@babylonslate/vfs";
import type { NativeClerkReverification } from "../services/native-clerk";
import type { NativeProfileEditing } from "./homepage-account-types";
import { storeSubscriptionsUrl } from "./homepage-plans";

function reason(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function release(hold: { current: (() => void) | null }) {
  hold.current?.();
  hold.current = null;
}

/**
 * Name and picture for accounts on the email-code client. Clerk's own account
 * screen does this on the web; here the same first and last name fields and
 * profile picture are edited in place.
 */
export function NativeProfileFields({
  profile,
  disabled,
}: {
  profile: NativeProfileEditing;
  disabled: boolean;
}) {
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [saved, setSaved] = useState([profile.firstName, profile.lastName]);
  const [busy, setBusy] = useState<"name" | "image" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickerHold = useRef<(() => void) | null>(null);
  const holdSessionCheck = profile.holdSessionCheck;
  // Returning from the system picker must not run the foreground session
  // check that hides the app (mobile) before the change event delivers the file.
  useEffect(() => {
    const input = fileInput.current;
    const cancelled = () => release(pickerHold);
    input?.addEventListener("cancel", cancelled);
    return () => {
      input?.removeEventListener("cancel", cancelled);
      release(pickerHold);
    };
  }, []);
  // Drafts follow the stored name once Clerk has accepted a change.
  if (saved[0] !== profile.firstName || saved[1] !== profile.lastName) {
    setSaved([profile.firstName, profile.lastName]);
    setFirstName(profile.firstName);
    setLastName(profile.lastName);
  }
  const changed =
    firstName.trim() !== profile.firstName ||
    lastName.trim() !== profile.lastName;
  const locked = disabled || busy !== null;

  async function run(kind: "name" | "image", action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(reason(cause, "Your profile could not be updated."));
    } finally {
      if (kind === "image") release(pickerHold);
      setBusy(null);
    }
  }

  return (
    <FieldSet data-testid="homepage-account-profile">
      <FieldLegend variant="label">Profile</FieldLegend>
      <FieldGroup>
        <form
          className="homepage-account-profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (locked || !changed) return;
            void run("name", () => profile.updateName({ firstName, lastName }));
          }}
        >
          <div className="homepage-account-profile-names">
            <Field>
              <FieldLabel htmlFor="native-profile-first-name">
                First Name
              </FieldLabel>
              <Input
                id="native-profile-first-name"
                name="firstName"
                autoComplete="given-name"
                value={firstName}
                disabled={locked}
                onChange={(event) => setFirstName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="native-profile-last-name">
                Last Name
              </FieldLabel>
              <Input
                id="native-profile-last-name"
                name="lastName"
                autoComplete="family-name"
                value={lastName}
                disabled={locked}
                onChange={(event) => setLastName(event.target.value)}
              />
            </Field>
          </div>
          <div className="homepage-account-center-actions">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={locked || !changed}
            >
              {busy === "name" && (
                <LoaderCircleIcon
                  data-icon="inline-start"
                  className="animate-spin"
                />
              )}
              Save Name
            </Button>
          </div>
        </form>
        <Field>
          {/* Not a label: it would open the picker without holding the session check. */}
          <FieldTitle>Profile Picture</FieldTitle>
          <div className="homepage-account-center-actions">
            <input
              ref={fileInput}
              type="file"
              aria-label="Profile Picture"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              tabIndex={-1}
              disabled={locked}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void run("image", () => profile.setImage(file));
                else release(pickerHold);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => {
                pickerHold.current ??= holdSessionCheck();
                fileInput.current?.click();
              }}
            >
              {busy === "image" ? (
                <LoaderCircleIcon
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : (
                <ImagePlusIcon data-icon="inline-start" />
              )}
              {profile.hasImage ? "Replace Picture" : "Upload Picture"}
            </Button>
            {profile.hasImage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => void run("image", profile.removeImage)}
              >
                Remove Picture
              </Button>
            )}
          </div>
          <FieldDescription>JPG, PNG, GIF or WEBP, up to 10 MB.</FieldDescription>
        </Field>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </FieldGroup>
    </FieldSet>
  );
}

/** What deleting the account leaves running: store subscriptions stay until the person cancels them. */
function SubscriptionNote() {
  const host = getHostPlatform();
  const url = storeSubscriptionsUrl(host);
  const store = host === "ios" ? "App Store" : "Google Play";
  return (
    <span className="mt-2 block" data-testid="homepage-account-delete-subscription">
      {url ? (
        <>
          Deleting your account does not cancel your {store} subscription.{" "}
          <a href={url} target="_blank" rel="noreferrer">
            Manage Subscriptions
          </a>
          .
        </>
      ) : (
        <>
          Deleting your account does not cancel an active subscription. Cancel
          it first with Manage Billing under Subscription.
        </>
      )}
    </span>
  );
}

/**
 * Self-service deletion, offered only when the Clerk dashboard allows it
 * (App Store guideline 5.1.1(v) requires it for apps with account creation).
 * Confirming emails a code first, so a device left unlocked cannot delete the
 * account; the account is deleted only once Clerk accepts that code.
 */
export function NativeDeleteAccount({
  profile,
  disabled,
  onDeleted,
}: {
  profile: NativeProfileEditing;
  disabled: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<NativeClerkReverification | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"send" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reading the code in a mail app must not run the foreground session check
  // that hides the app (mobile) and would drop this dialog.
  const codeHold = useRef<(() => void) | null>(null);
  useEffect(() => () => release(codeHold), []);
  if (!profile.canDelete) return null;

  function close() {
    release(codeHold);
    setOpen(false);
    setPending(null);
    setCode("");
    setError(null);
  }

  async function sendCode() {
    setBusy("send");
    setError(null);
    codeHold.current ??= profile.holdSessionCheck();
    try {
      setPending(await profile.sendDeleteCode(pending ?? undefined));
    } catch (cause) {
      setError(reason(cause, "The code could not be sent."));
      if (!pending) release(codeHold);
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!pending || !code.trim()) return;
    setBusy("delete");
    setError(null);
    try {
      await profile.deleteAccount(pending, code);
      close();
      onDeleted();
    } catch (cause) {
      setError(reason(cause, "Your account could not be deleted."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Field data-testid="homepage-account-delete">
        <FieldDescription>
          Permanently delete your Haptic account. Projects stored on this
          device are not deleted.
        </FieldDescription>
        <div className="homepage-account-center-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || open}
            onClick={() => setOpen(true)}
          >
            <Trash2Icon data-icon="inline-start" />
            Delete Account
          </Button>
        </div>
      </Field>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          if (next) setOpen(true);
          else close();
        }}
      >
        <AlertDialogContent
          className="homepage-theme"
          variant="destructive"
          data-testid="homepage-account-delete-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Account?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes your Haptic account and signs you out of
              this device. It cannot be undone. Projects stored on this device
              are not deleted.
              <SubscriptionNote />
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              <Field>
                <FieldLabel htmlFor="native-delete-code">
                  Verification Code
                </FieldLabel>
                <Input
                  id="native-delete-code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  disabled={busy !== null}
                  onChange={(event) => setCode(event.target.value)}
                />
                <FieldDescription>
                  To confirm it is you, enter the code sent to {pending.email}.
                </FieldDescription>
              </Field>
            </form>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            {pending ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void sendCode()}
                >
                  Resend Code
                </Button>
                <AlertDialogAction
                  variant="destructive"
                  disabled={busy !== null || !code.trim()}
                  onClick={() => void confirm()}
                >
                  {busy === "delete" ? "Deleting…" : "Delete Account"}
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void sendCode()}
              >
                {busy === "send" ? "Sending…" : "Send Code"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
