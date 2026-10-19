import { BuildingIcon, MonitorIcon, SmartphoneIcon, type LucideIcon } from "lucide-react";
import type { HostPlatform } from "@babylonslate/vfs";
import type { HapticPlanId } from "./homepage-account-types";

/** Public pricing, kept in step with https://haptic.no/pricing. */
export const HAPTIC_PRICING_URL = "https://haptic.no/pricing";
export const HAPTIC_SALES_EMAIL = "mail@hideout.no";

export const HAPTIC_PLANS: ReadonlyArray<{
  id: HapticPlanId;
  audience: string;
  name: string;
  price: string;
  summary: string;
  features: readonly string[];
  icon: LucideIcon;
}> = [
  {
    id: "free",
    audience: "Desktop",
    name: "Haptic",
    price: "Free",
    summary: "The full desktop editor",
    features: ["Mac, Windows and Linux", "For revenue under $50,000 a year"],
    icon: MonitorIcon,
  },
  {
    id: "pro",
    audience: "Phone and Tablet",
    name: "Haptic Pro",
    price: "Price Coming Soon",
    summary: "Haptic on iPhone, iPad and Android",
    features: [
      "One account for all your devices",
      "For revenue over $50,000 a year",
    ],
    icon: SmartphoneIcon,
  },
  {
    id: "enterprise",
    audience: "Studios and Large Teams",
    name: "Enterprise",
    price: "Let’s Talk",
    summary: "Everything in Haptic Pro",
    features: ["Seats for your whole team"],
    icon: BuildingIcon,
  },
];

/**
 * The store page where a subscription bought in the phone or tablet app is
 * managed. Deleting a Haptic account never cancels it. Desktop subscriptions
 * run through Web Billing and are managed from Subscription instead.
 */
export function storeSubscriptionsUrl(host: HostPlatform): string | null {
  if (host === "ios") return "https://apps.apple.com/account/subscriptions";
  if (host === "android")
    return "https://play.google.com/store/account/subscriptions";
  return null;
}
