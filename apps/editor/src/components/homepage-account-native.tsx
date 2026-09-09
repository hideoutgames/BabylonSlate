import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRightIcon, MailIcon } from "lucide-react";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  createNativeClerkClient,
  type NativeClerkChallenge,
  type NativeClerkSession,
} from "../services/native-clerk";
import { NativeHomepageAccountContext } from "./homepage-account-context";
import { HomepageMobileAccountFrame } from "./homepage-mobile-account-gate";

function accountError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Your account could not connect. Please try again.";
}

export default function HomepageNativeAccount({
  publishableKey,
  children,
  onRetry,
  frame: Frame = HomepageMobileAccountFrame,
  optional = false,
}: {
  publishableKey: string;
  children: ReactNode;
  onRetry: () => void;
  frame?: (props: { children: ReactNode }) => ReactNode;
  optional?: boolean;
}) {
  const client = useMemo(
    () => createNativeClerkClient(publishableKey),
    [publishableKey],
  );
  const [session, setSession] = useState<NativeClerkSession | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<NativeClerkChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const currentSession = useRef<NativeClerkSession | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    let pending = false;
    const restore = () => {
      if (cancelled || pending || busyRef.current) return;
      pending = true;
      setRestoring(true);
      setRestoreError(null);
      void client.restoreSession().then(
        (restored) => {
          if (cancelled) return;
          currentSession.current = restored;
          setSession(restored);
          setRestoring(false);
          pending = false;
        },
        (cause: unknown) => {
          if (cancelled) return;
          setRestoreError(accountError(cause));
          setRestoring(false);
          pending = false;
        },
      );
    };
    const resume = () => {
      if (document.visibilityState === "visible" && currentSession.current) {
        restore();
      }
    };
    restore();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      cancelled = true;
      alive.current = false;
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [client]);

  useEffect(() => {
    if (!restoring && !session) input.current?.focus();
  }, [challenge, mode, restoring, session]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (cause) {
      if (alive.current) setError(accountError(cause));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (restoring) {
    return (
      <Frame>
        <p role="status">Connecting your account…</p>
      </Frame>
    );
  }
  if (restoreError) {
    return (
      <Frame>
        <h1>Let’s Get You Connected</h1>
        <Alert variant="destructive">
          <AlertDescription>{restoreError}</AlertDescription>
        </Alert>
        <Button size="touch" onClick={onRetry}>
          Try Again
        </Button>
      </Frame>
    );
  }
  if (session) {
    return (
      <NativeHomepageAccountContext.Provider
        value={{
          session,
          signOut: async () => {
            if (busyRef.current) return;
            busyRef.current = true;
            setRestoring(true);
            try {
              await client.signOut(session);
              if (!alive.current) return;
              currentSession.current = null;
              setSession(null);
              setChallenge(null);
              setCode("");
              setError(null);
              setStatus(null);
            } catch (cause) {
              if (alive.current) setRestoreError(accountError(cause));
            } finally {
              busyRef.current = false;
              if (alive.current) setRestoring(false);
            }
          },
        }}
      >
        {children}
      </NativeHomepageAccountContext.Provider>
    );
  }

  return (
    <Frame>
      <span className="homepage-native-auth-icon">
        <MailIcon aria-hidden="true" />
      </span>
      <h1>
        {challenge
          ? "Check Your Inbox"
          : mode === "sign-up"
            ? "Make Yourself at Home"
            : optional
              ? "Your Slate Account"
              : "Your Studio. Everywhere."}
      </h1>
      <p>
        {challenge
          ? `Enter the code sent to ${challenge.email}.`
          : optional
            ? "Sign in with an email code, or keep creating as a guest."
            : "Sign in to use Slate on this device. Every editor feature is included."}
      </p>
      <form
        className="homepage-native-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (challenge && code.trim()) {
            void run(async () => {
              const verified = await client.verifyCode(challenge, code.trim());
              if (alive.current) {
                currentSession.current = verified;
                setSession(verified);
              }
            });
          } else if (!challenge && email.trim()) {
            void run(async () => {
              const nextChallenge = await client.beginEmail(email.trim(), mode);
              if (!alive.current) return;
              setChallenge(nextChallenge);
              setCode("");
            });
          }
        }}
      >
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel
              htmlFor={
                challenge ? "native-account-code" : "native-account-email"
              }
            >
              {challenge ? "Verification Code" : "Email Address"}
            </FieldLabel>
            {challenge ? (
              <Input
                ref={input}
                id="native-account-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                maxLength={12}
                required
                disabled={busy}
                aria-invalid={!!error}
                onChange={(event) => {
                  setCode(event.target.value);
                  setError(null);
                }}
              />
            ) : (
              <Input
                ref={input}
                id="native-account-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                required
                disabled={busy}
                aria-invalid={!!error}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
        </FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {status && <p role="status">{status}</p>}
        <Button
          type="submit"
          size="touch"
          disabled={busy || !(challenge ? code.trim() : email.trim())}
        >
          {busy
            ? "One Moment…"
            : challenge
              ? "Verify & Continue"
              : "Continue With Email"}
          <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </form>
      <div className="homepage-native-auth-actions">
        {challenge ? (
          <>
            <Button
              variant="ghost"
              size="touch"
              disabled={busy}
              onClick={() => {
                void run(async () => {
                  const nextChallenge = await client.resendCode(challenge);
                  if (!alive.current) return;
                  setChallenge(nextChallenge);
                  setCode("");
                  setStatus("A fresh code is on its way.");
                });
              }}
            >
              Resend Code
            </Button>
            <Button
              variant="ghost"
              size="touch"
              disabled={busy}
              onClick={() => {
                setChallenge(null);
                setCode("");
                setError(null);
                setStatus(null);
              }}
            >
              Use Another Email
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="touch"
            disabled={busy}
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              setError(null);
              setStatus(null);
            }}
          >
            {mode === "sign-in" ? "Create Account" : "Back To Sign In"}
          </Button>
        )}
      </div>
      <p className="homepage-native-auth-note">
        Your projects stay on this device.
      </p>
    </Frame>
  );
}
