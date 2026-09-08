import {
  ArrowLeftIcon,
  CheckIcon,
  MonitorIcon,
  SmartphoneIcon,
} from "lucide-react";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";

const PLANS = [
  {
    id: "free",
    name: "Free",
    description: "Big ideas begin here.",
    icon: MonitorIcon,
    features: ["Full Editor Access", "Desktop App Access"],
    status: "Free to Create",
  },
  {
    id: "pro",
    name: "Pro",
    description: "Your studio, wherever you go.",
    icon: SmartphoneIcon,
    features: ["Full Editor Access", "Desktop App Access", "Mobile App Access"],
    status: "Coming Later",
  },
] as const;

export function HomepageSubscription({ onBack }: { onBack: () => void }) {
  return (
    <div className="homepage-subscription" data-testid="homepage-subscription">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeftIcon data-icon="inline-start" />
        Back To Profile
      </Button>
      <DialogHeader>
        <Badge variant="outline">A Look Ahead</Badge>
        <DialogTitle>Room to Create</DialogTitle>
        <DialogDescription>
          The same creative tools. A little more freedom to take them with you.
        </DialogDescription>
      </DialogHeader>
      <div className="homepage-subscription-plans">
        {PLANS.map((plan) => (
          <Card
            key={plan.id}
            className="homepage-subscription-plan"
            data-plan={plan.id}
          >
            <CardHeader>
              <plan.icon aria-hidden="true" />
              <CardTitle>
                <h3>{plan.name}</h3>
              </CardTitle>
              <CardDescription>{plan.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <CheckIcon aria-hidden="true" />
                    {feature}
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Badge variant="secondary">{plan.status}</Badge>
            </CardFooter>
          </Card>
        ))}
      </div>
      <p className="homepage-subscription-note">
        Preview only. Plans are not on sale and access is not restricted. Pro
        will add mobile app access; every other editor feature is included in
        both plans.
      </p>
    </div>
  );
}
