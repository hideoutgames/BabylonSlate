import { useRef, useState } from "react";
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
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import type { NativeProfileEditing } from "./homepage-account-types";

function reason(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
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
          <FieldLabel htmlFor="native-profile-picture">Profile Picture</FieldLabel>
          <div className="homepage-account-center-actions">
            <input
              ref={fileInput}
              id="native-profile-picture"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              tabIndex={-1}
              disabled={locked}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void run("image", () => profile.setImage(file));
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => fileInput.current?.click()}
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

/**
 * Self-service deletion, offered only when the Clerk dashboard allows it
 * (App Store guideline 5.1.1(v) requires it for apps with account creation).
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
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!profile.canDelete) return null;

  async function confirm() {
    setDeleting(true);
    setError(null);
    try {
      await profile.deleteAccount();
      setOpen(false);
      onDeleted();
    } catch (cause) {
      setError(reason(cause, "Your account could not be deleted."));
    } finally {
      setDeleting(false);
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
            disabled={disabled || deleting}
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
          if (deleting) return;
          setOpen(next);
          if (!next) setError(null);
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
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirm()}
            >
              {deleting ? "Deleting…" : "Delete Account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
