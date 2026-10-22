import { useState, type ReactNode } from "react";
import {
  CheckIcon,
  CircleUserRoundIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  LogInIcon,
  LogOutIcon,
  MailIcon,
  RotateCcwIcon,
  UserPlusIcon,
  UserRoundCogIcon,
} from "lucide-react";
import { CatalogDialog } from "@babylonslate/editor-kit";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { ApplicationSettingsFields } from "./homepage-application-settings";
import type {
  AccountDetails,
  BillingController,
  NativeProfileEditing,
} from "./homepage-account-types";
import {
  NativeDeleteAccount,
  NativeProfileFields,
} from "./homepage-account-native-profile";
import {
  HAPTIC_PLANS,
  HAPTIC_PRICING_URL,
  HAPTIC_SALES_EMAIL,
} from "./homepage-plans";

const SECTIONS = [
  { id: "account", label: "Account", keywords: "account profile name picture photo avatar email security sign in out create delete" },
  { id: "subscription", label: "Subscription", keywords: "subscription plan pro free enterprise billing payment invoice" },
  { id: "application", label: "Application", keywords: "application updates automatic theme style color colors appearance import export interface compact mode density touch legal third-party notices licenses licences open source" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function DetailRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="homepage-account-detail">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AccountSection({
  account,
  nativeProfile,
  busy,
  onSignIn,
  onSignUp,
  onSignOut,
  signOutLabel,
  onManageAccount,
  onAccountDeleted,
}: {
  account: AccountDetails;
  nativeProfile?: NativeProfileEditing;
  busy: boolean;
  onSignIn?: () => void;
  onSignUp?: () => void;
  onSignOut?: () => void;
  signOutLabel: string;
  onManageAccount?: () => void;
  onAccountDeleted: () => void;
}) {
  const signedIn = Boolean(onSignOut);
  return (
    <div className="homepage-account-center-page">
      <section className="homepage-account-center-identity">
        {account.imageUrl ? (
          <img className="homepage-account-center-avatar" src={account.imageUrl} alt="" />
        ) : (
          <CircleUserRoundIcon className="homepage-account-center-avatar" aria-hidden="true" />
        )}
        <div className="homepage-account-center-text">
          <h3>{account.name}</h3>
          <p>{account.email ?? account.status}</p>
        </div>
      </section>
      {signedIn ? (
        <>
          <dl className="homepage-account-details">
            <DetailRow label="Email" value={account.email} />
            <DetailRow
              label="Member Since"
              value={account.memberSince && dateFormat.format(account.memberSince)}
            />
            <DetailRow
              label="Last Sign-In"
              value={account.lastSignInAt && dateFormat.format(account.lastSignInAt)}
            />
            <DetailRow
              label="Sign-In Methods"
              value={account.signInMethods?.join(", ")}
            />
          </dl>
          {nativeProfile && (
            <NativeProfileFields profile={nativeProfile} disabled={busy} />
          )}
          <div className="homepage-account-center-actions">
            {onManageAccount && (
              <Button variant="outline" size="sm" onClick={onManageAccount}>
                <UserRoundCogIcon data-icon="inline-start" />
                Manage Account
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy} onClick={onSignOut}>
              <LogOutIcon data-icon="inline-start" />
              {signOutLabel}
            </Button>
          </div>
          {onManageAccount && (
            <p className="homepage-account-center-note">
              Manage Account opens your account settings, where you can change
              your name, picture and connected accounts, or delete your
              account. Deleting your account does not cancel a subscription;
              cancel it first with Manage Billing under Subscription.
            </p>
          )}
          {nativeProfile && (
            <NativeDeleteAccount
              profile={nativeProfile}
              disabled={busy}
              onDeleted={onAccountDeleted}
            />
          )}
        </>
      ) : (
        <>
          <p className="homepage-account-center-note">
            Sign in to use Haptic Pro on your phone and tablet with one account
            and one subscription.
          </p>
          <div className="homepage-account-center-actions">
            <Button size="sm" disabled={!onSignIn} onClick={onSignIn}>
              <LogInIcon data-icon="inline-start" />
              Sign In
            </Button>
            <Button variant="outline" size="sm" disabled={!onSignUp} onClick={onSignUp}>
              <UserPlusIcon data-icon="inline-start" />
              Create Account
            </Button>
          </div>
          {!onSignIn && (
            <Alert>
              <AlertDescription>
                Accounts are not connected for this build yet.
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}

function SubscriptionSection({
  billing,
  signedIn,
}: {
  billing: BillingController;
  signedIn: boolean;
}) {
  const current = HAPTIC_PLANS.find((plan) => plan.id === billing.currentPlan);
  const blocked = billing.unavailableReason ?? (signedIn ? null : "Sign in to subscribe.");
  const manageButton = (
    <Button variant="outline" size="sm" disabled={Boolean(blocked) || billing.currentPlan === "free"}>
      <CreditCardIcon data-icon="inline-start" />
      Manage Billing
    </Button>
  );
  return (
    <div className="homepage-account-center-page">
      <section className="homepage-billing-summary">
        <div>
          <span className="homepage-billing-label">Current Plan</span>
          <h3>{current?.name ?? "Haptic"}</h3>
          <p>
            {billing.currentPlan === "free"
              ? "Free on Mac, Windows and Linux."
              : [billing.status, billing.renewsAt && `Renews ${dateFormat.format(billing.renewsAt)}`]
                  .filter(Boolean)
                  .join(" · ")}
          </p>
        </div>
        <div className="homepage-account-center-actions">
          {billing.onRestore && (
            <Button
              variant="ghost"
              size="sm"
              disabled={Boolean(billing.unavailableReason)}
              onClick={billing.onRestore}
            >
              <RotateCcwIcon data-icon="inline-start" />
              Restore Purchases
            </Button>
          )}
          {billing.renderManage && !blocked ? billing.renderManage(manageButton) : manageButton}
        </div>
      </section>
      {blocked && (
        <Alert>
          <AlertDescription>{blocked}</AlertDescription>
        </Alert>
      )}
      <div className="homepage-plan-grid">
        {HAPTIC_PLANS.map((plan) => {
          const isCurrent = plan.id === billing.currentPlan;
          let action: ReactNode;
          if (isCurrent) {
            action = <Badge variant="secondary">Current Plan</Badge>;
          } else if (plan.id === "pro") {
            const subscribe = (
              <Button size="sm" disabled={Boolean(blocked)}>
                Subscribe
              </Button>
            );
            action = billing.renderSubscribe && !blocked ? billing.renderSubscribe(subscribe) : subscribe;
          } else if (plan.id === "enterprise") {
            action = (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<a href={`mailto:${HAPTIC_SALES_EMAIL}`} target="_blank" rel="noreferrer" />}
              >
                <MailIcon data-icon="inline-start" />
                Contact Sales
              </Button>
            );
          }
          return (
            <article
              key={plan.id}
              className="homepage-plan"
              data-plan={plan.id}
              data-current={isCurrent}
            >
              <header>
                <plan.icon aria-hidden="true" />
                <span>{plan.audience}</span>
              </header>
              <h4>{plan.name}</h4>
              <p className="homepage-plan-price">{plan.price}</p>
              <p className="homepage-plan-summary">{plan.summary}</p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <CheckIcon aria-hidden="true" />
                    {feature}
                  </li>
                ))}
              </ul>
              <footer>{action}</footer>
            </article>
          );
        })}
      </div>
      <p className="homepage-account-center-note">
        Desktop is free while you, or the company you work for, makes less than
        $50,000 a year. One Haptic Pro subscription covers every phone and
        tablet you sign in on. Teams need one subscription per seat.{" "}
        <a href={HAPTIC_PRICING_URL} target="_blank" rel="noreferrer">
          Pricing Details
          <ExternalLinkIcon aria-hidden="true" />
        </a>
      </p>
    </div>
  );
}

/**
 * The account area behind the profile menu's identity row: the signed-in
 * account, Haptic plans and billing, and application-wide preferences.
 */
export function HomepageAccountCenter({
  open,
  onOpenChange,
  account,
  nativeProfile,
  billing,
  busy,
  onSignIn,
  onSignUp,
  onSignOut,
  signOutLabel,
  onManageAccount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountDetails;
  /** Native accounts edit their profile here; web accounts use `onManageAccount`. */
  nativeProfile?: NativeProfileEditing;
  billing: BillingController;
  busy: boolean;
  onSignIn?: () => void;
  onSignUp?: () => void;
  onSignOut?: () => void;
  signOutLabel: string;
  onManageAccount?: () => void;
}) {
  const [section, setSection] = useState<SectionId>("account");
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const visible = SECTIONS.filter(
    (item) => !query || `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(query),
  );
  const active = visible.some((item) => item.id === section)
    ? section
    : visible[0]?.id;
  let content: ReactNode;
  if (active === "account") {
    content = (
      <AccountSection
        account={account}
        nativeProfile={nativeProfile}
        busy={busy}
        onSignIn={onSignIn}
        onSignUp={onSignUp}
        onSignOut={onSignOut}
        signOutLabel={signOutLabel}
        onManageAccount={onManageAccount}
        onAccountDeleted={() => onOpenChange(false)}
      />
    );
  } else if (active === "subscription") {
    content = <SubscriptionSection billing={billing} signedIn={Boolean(onSignOut)} />;
  } else if (active === "application") {
    content = <ApplicationSettingsFields />;
  } else {
    content = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No Matching Settings</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <CatalogDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSearch("");
        onOpenChange(next);
      }}
      title="Account"
      categories={visible.map(({ id, label }) => ({ id, label }))}
      activeCategoryId={active ?? "account"}
      onCategoryChange={(id) => setSection(id as SectionId)}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search Account"
      className="settings-dialog homepage-theme homepage-account-center"
      data-testid="homepage-account-center"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      }
    >
      {content}
    </CatalogDialog>
  );
}
