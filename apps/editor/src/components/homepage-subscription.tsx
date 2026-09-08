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
    icon: MonitorIcon,
    features: ["Full Editor Access", "Desktop App Access"],
    status: "Free",
  },
  {
    id: "pro",
    name: "Pro",
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
        Profile
      </Button>
      <DialogHeader>
        <Badge variant="outline">Preview</Badge>
        <DialogTitle>Plans</DialogTitle>
        <DialogDescription>Full editor access on both plans.</DialogDescription>
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
        Purchases are not available yet.
      </p>
    </div>
  );
}
