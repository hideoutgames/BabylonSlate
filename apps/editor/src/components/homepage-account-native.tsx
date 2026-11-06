import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CloudOffIcon,
  LockIcon,
  RotateCwIcon,
} from "lucide-react";
import Apple from "react-bootstrap-icons/dist/icons/apple";
import Discord from "react-bootstrap-icons/dist/icons/discord";
import Github from "react-bootstrap-icons/dist/icons/github";
import Google from "react-bootstrap-icons/dist/icons/google";
import { createAuthBrowser, getHostPlatform } from "@haptic/vfs";
import { Alert, AlertDescription } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import {
  createNativeClerkClient,
  type NativeClerkChallenge,
  type NativeClerkSession,
} from "../services/native-clerk";
import { NativeHomepageAccountContext } from "./homepage-account-context";
import { nativeProfileActions } from "./homepage-account-native-actions";
import {
  HomepageAccountNotice,
  HomepageAccountProgress,
  HomepageMobileAccountFrame,
} from "./homepage-mobile-account-gate";

/** Where Clerk returns the system browser; allowlisted as a mobile SSO redirect in Clerk. */
export const SSO_REDIRECT_URL = "haptic://sso-callback";

/** Providers the apps complete in the system browser, in display order. */
const SOCIAL_PROVIDERS = [
  { strategy: "oauth_github", name: "GitHub", Icon: Github },
  { strategy: "oauth_discord", name: "Discord", Icon: Discord },
  { strategy: "oauth_google", name: "Google", Icon: Google },
] as const;

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
}: {
  publishableKey: string;
  children: ReactNode;
  onRetry: () => void;
  frame?: (props: { children: ReactNode }) => ReactNode;
}) {
  const client = useMemo(
    () => createNativeClerkClient(publishableKey),
    [publishableKey],
  );
  const browser = useMemo(() => createAuthBrowser(), []);
  const host = getHostPlatform();
  const [strategies, setStrategies] = useState<readonly string[]>([]);
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
  // Open system file pickers; the foreground check waits for them to close.
  const pickers = useRef(0);
  const alive = useRef(true);
  const currentSession = useRef<NativeClerkSession | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    let pending = false;
    const restore = () => {
      if (cancelled || pending || busyRef.current || pickers.current > 0) return;
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

  // Only providers Clerk enables, and only where a system browser can finish them.
  useEffect(() => {
    if (!browser || restoring || session) return;
    let cancelled = false;
    void client.socialStrategies().then(
      (next) => {
        if (!cancelled) setStrategies(next);
      },
      () => {
        if (!cancelled) setStrategies([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [browser, client, restoring, session]);

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
        <HomepageAccountProgress label="Connecting your account…" />
      </Frame>
    );
  }
  if (restoreError) {
    return (
      <Frame>
        <HomepageAccountNotice
          icon={<CloudOffIcon aria-hidden="true" />}
          tone="destructive"
          title="Let’s Get You Connected"
        />
        <Alert variant="destructive">
          <AlertDescription>{restoreError}</AlertDescription>
        </Alert>
        <Button onClick={onRetry}>
          <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
          Try Again
        </Button>
      </Frame>
    );
  }
  if (session) {
    const leaveSession = () => {
      currentSession.current = null;
      setSession(null);
      setChallenge(null);
      setCode("");
      setError(null);
      setStatus(null);
    };
    return (
      <NativeHomepageAccountContext.Provider
        value={{
          session,
          profile: nativeProfileActions(client, session, {
            onSession: (next) => {
              if (!alive.current) return;
              currentSession.current = next;
              setSession(next);
            },
            onDeleted: () => {
              if (alive.current) leaveSession();
            },
            holdSessionCheck: () => {
              pickers.current += 1;
              let held = true;
              return () => {
                if (!held) return;
                held = false;
                pickers.current -= 1;
              };
            },
          }),
          signOut: async () => {
            if (busyRef.current) return;
            busyRef.current = true;
            setRestoring(true);
            try {
              await client.signOut(session);
              if (!alive.current) return;
              leaveSession();
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

  const providers = browser
    ? SOCIAL_PROVIDERS.filter((provider) => strategies.includes(provider.strategy))
    : [];
  // Sign in with Apple is not available yet; iOS shows where it will be.
  const appleSoon = host === "ios";

  function signInWith(strategy: string) {
    if (!browser) return;
    void run(async () => {
      const oauth = await client.beginOAuth(strategy, SSO_REDIRECT_URL);
      const callback = await browser.open(oauth.url, SSO_REDIRECT_URL);
      if (!callback || !alive.current) return;
      const next = await client.completeOAuth(oauth, callback);
      if (!alive.current) return;
      currentSession.current = next;
      setSession(next);
    });
  }

  return (
    <Frame>
      <header className="homepage-native-auth-intro">
        <h1>
          {challenge
            ? "Check Your Inbox"
            : mode === "sign-up"
              ? "Sign Up With"
              : "Sign In With"}
        </h1>
        {challenge && (
          <p>
            Enter the code sent to <strong>{challenge.email}</strong>.
          </p>
        )}
      </header>
      {!challenge && (appleSoon || providers.length > 0) && (
        <>
          <div className="homepage-native-auth-providers">
            {appleSoon && (
              <Button type="button" variant="outline" disabled>
                <Apple data-icon="inline-start" aria-hidden="true" />
                Apple
              </Button>
            )}
            {providers.map(({ strategy, name, Icon }) => (
              <Button
                key={strategy}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => signInWith(strategy)}
              >
                <Icon data-icon="inline-start" aria-hidden="true" />
                {name}
              </Button>
            ))}
          </div>
          <div className="homepage-native-auth-divider" role="separator">
            or
          </div>
        </>
      )}
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
                className="homepage-native-auth-code"
                name="code"
                inputMode="numeric"
                placeholder="000000"
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
      {challenge ? (
        <div className="homepage-native-auth-actions" data-layout="split">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setChallenge(null);
              setCode("");
              setError(null);
              setStatus(null);
            }}
          >
            <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
            Use Another Email
          </Button>
          <Button
            variant="ghost"
            size="sm"
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
        </div>
      ) : (
        <div className="homepage-native-auth-actions">
          <span>
            {mode === "sign-in" ? "New to Haptic?" : "Already have an account?"}
          </span>
          <Button
            variant="link"
            size="sm"
            disabled={busy}
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              setError(null);
              setStatus(null);
            }}
          >
            {mode === "sign-in" ? "Create Account" : "Back To Sign In"}
          </Button>
        </div>
      )}
      <p className="homepage-native-auth-secured">
        <LockIcon aria-hidden="true" />
        <span>
          Secured by <strong>Clerk</strong>
        </span>
      </p>
    </Frame>
  );
}
