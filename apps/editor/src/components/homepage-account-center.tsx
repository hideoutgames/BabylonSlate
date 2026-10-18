import { useState, type ReactNode } from "react";
import {
  CircleUserRoundIcon,
  LogInIcon,
  LogOutIcon,
  UserRoundCogIcon,
} from "lucide-react";
import { CatalogDialog } from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { ApplicationSettingsFields } from "./homepage-application-settings";
import { SubscriptionPlans } from "./homepage-subscription";

const SECTIONS = [
  { id: "account", label: "Account", keywords: "account profile sign in out" },
  { id: "subscription", label: "Subscription", keywords: "subscription plan pro free billing" },
  { id: "application", label: "Application", keywords: "application updates automatic" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * The account area behind the profile menu's identity row: who is signed in,
 * the subscription plans and application-wide preferences.
 */
export function HomepageAccountCenter({
  open,
  onOpenChange,
  name,
  status,
  imageUrl,
  busy,
  onSignIn,
  onSignOut,
  signOutLabel,
  onManageAccount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  status: string;
  imageUrl?: string;
  busy: boolean;
  onSignIn?: () => void;
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
      <section className="homepage-account-center-identity">
        {imageUrl ? (
          <img className="homepage-account-center-avatar" src={imageUrl} alt="" />
        ) : (
          <CircleUserRoundIcon
            className="homepage-account-center-avatar"
            aria-hidden="true"
          />
        )}
        <div className="homepage-account-center-text">
          <h3>{name}</h3>
          <p>{status}</p>
        </div>
        <div className="homepage-account-center-actions">
          {onManageAccount && (
            <Button variant="outline" size="sm" onClick={onManageAccount}>
              <UserRoundCogIcon data-icon="inline-start" />
              Account Settings
            </Button>
          )}
          {onSignIn && (
            <Button size="sm" onClick={onSignIn}>
              <LogInIcon data-icon="inline-start" />
              Sign In
            </Button>
          )}
          {onSignOut && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onSignOut}>
              <LogOutIcon data-icon="inline-start" />
              {signOutLabel}
            </Button>
          )}
        </div>
      </section>
    );
  } else if (active === "subscription") {
    content = (
      <section className="homepage-account-center-section">
        <header>
          <h3>Plans</h3>
          <Badge variant="outline">Preview</Badge>
        </header>
        <p>Full editor access on both plans.</p>
        <SubscriptionPlans />
      </section>
    );
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
      size="medium"
      className="settings-dialog homepage-account-center"
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
