import type { LucideIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { useHomepageCardTouch } from "./use-homepage-card-touch";

export type WelcomeStarter = {
  id: string;
  name: string;
  icon: LucideIcon;
  imageUrl?: string;
};

function WelcomeTile({
  starter,
  disabled,
  onStart,
}: {
  starter: WelcomeStarter;
  disabled: boolean;
  onStart: () => void;
}) {
  const touch = useHomepageCardTouch(!disabled);
  const Icon = starter.icon;
  return (
    <Button
      type="button"
      variant="ghost"
      className="homepage-welcome-tile"
      data-testid={`homepage-empty-start-${starter.id}`}
      data-picture={starter.imageUrl ? "true" : undefined}
      disabled={disabled}
      onPointerDown={touch.onPointerDown}
      onPointerEnter={touch.onPointerEnter}
      onClick={(event) => {
        if (touch.shouldActivate(event)) onStart();
      }}
    >
      {starter.imageUrl ? (
        <img src={starter.imageUrl} alt="" draggable={false} />
      ) : (
        <Icon aria-hidden="true" />
      )}
      <span>{starter.name}</span>
    </Button>
  );
}

/**
 * The empty project library: one heading and a tile per starter template.
 * A tile starts a new project from that template.
 */
export function HomepageWelcome({
  starters,
  disabled,
  onStart,
  onBrowse,
}: {
  starters: WelcomeStarter[];
  disabled: boolean;
  onStart: (id: string) => void;
  onBrowse: () => void;
}) {
  return (
    <section
      className="homepage-welcome"
      data-testid="homepage-projects-empty"
      aria-labelledby="homepage-welcome-title"
    >
      <h3 id="homepage-welcome-title">Start Your First Project</h3>
      <div className="homepage-welcome-grid">
        {starters.map((starter) => (
          <WelcomeTile
            key={starter.id}
            starter={starter}
            disabled={disabled}
            onStart={() => onStart(starter.id)}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="homepage-welcome-browse"
        disabled={disabled}
        onClick={onBrowse}
      >
        All Templates
      </Button>
    </section>
  );
}
