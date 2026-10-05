export const ENGINE_EASING_CURVE_ENUM_ID = "engine:EasingCurve";

/** Stable order: engine enum values are persisted as their index in this list. */
export const EASING_CURVES = [
  "linear",
  "quadIn", "quadOut", "quadInOut",
  "cubicIn", "cubicOut", "cubicInOut",
  "quartIn", "quartOut", "quartInOut",
  "quintIn", "quintOut", "quintInOut",
  "sineIn", "sineOut", "sineInOut",
  "expoIn", "expoOut", "expoInOut",
  "circIn", "circOut", "circInOut",
  "backIn", "backOut", "backInOut",
  "elasticIn", "elasticOut", "elasticInOut",
  "bounceIn", "bounceOut", "bounceInOut",
] as const;

export type EasingCurve = (typeof EASING_CURVES)[number];

export const EASING_CURVE_LABELS: Record<EasingCurve, string> = {
  linear: "Linear",
  quadIn: "Quad In", quadOut: "Quad Out", quadInOut: "Quad In Out",
  cubicIn: "Cubic In", cubicOut: "Cubic Out", cubicInOut: "Cubic In Out",
  quartIn: "Quart In", quartOut: "Quart Out", quartInOut: "Quart In Out",
  quintIn: "Quint In", quintOut: "Quint Out", quintInOut: "Quint In Out",
  sineIn: "Sine In", sineOut: "Sine Out", sineInOut: "Sine In Out",
  expoIn: "Expo In", expoOut: "Expo Out", expoInOut: "Expo In Out",
  circIn: "Circ In", circOut: "Circ Out", circInOut: "Circ In Out",
  backIn: "Back In", backOut: "Back Out", backInOut: "Back In Out",
  elasticIn: "Elastic In", elasticOut: "Elastic Out", elasticInOut: "Elastic In Out",
  bounceIn: "Bounce In", bounceOut: "Bounce Out", bounceInOut: "Bounce In Out",
};

export function parseEasingCurve(value: unknown): EasingCurve {
  if (typeof value === "number" && Number.isInteger(value)) return EASING_CURVES[value] ?? "linear";
  return EASING_CURVES.includes(value as EasingCurve) ? value as EasingCurve : "linear";
}

function bounceOut(t: number): number {
  const scale = 7.5625;
  const period = 2.75;
  if (t < 1 / period) return scale * t * t;
  if (t < 2 / period) return scale * (t - 1.5 / period) ** 2 + 0.75;
  if (t < 2.5 / period) return scale * (t - 2.25 / period) ** 2 + 0.9375;
  return scale * (t - 2.625 / period) ** 2 + 0.984375;
}

/** Clamp time, not the result: Back and Elastic retain their overshoot. */
export function sampleEasingCurve(curve: EasingCurve, value: number): number {
  const t = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  if (t === 0 || t === 1) return t;
  const back = 1.70158;
  switch (curve) {
    case "linear": return t;
    case "quadIn": return t * t;
    case "quadOut": return 1 - (1 - t) ** 2;
    case "quadInOut": return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    case "cubicIn": return t ** 3;
    case "cubicOut": return 1 - (1 - t) ** 3;
    case "cubicInOut": return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    case "quartIn": return t ** 4;
    case "quartOut": return 1 - (1 - t) ** 4;
    case "quartInOut": return t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2;
    case "quintIn": return t ** 5;
    case "quintOut": return 1 - (1 - t) ** 5;
    case "quintInOut": return t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2;
    case "sineIn": return 1 - Math.cos(t * Math.PI / 2);
    case "sineOut": return Math.sin(t * Math.PI / 2);
    case "sineInOut": return (1 - Math.cos(Math.PI * t)) / 2;
    case "expoIn": return 2 ** (10 * t - 10);
    case "expoOut": return 1 - 2 ** (-10 * t);
    case "expoInOut": return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
    case "circIn": return 1 - Math.sqrt(1 - t * t);
    case "circOut": return Math.sqrt(1 - (t - 1) ** 2);
    case "circInOut": return t < 0.5
      ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
      : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2;
    case "backIn": return (back + 1) * t ** 3 - back * t * t;
    case "backOut": return 1 + (back + 1) * (t - 1) ** 3 + back * (t - 1) ** 2;
    case "backInOut": {
      const amount = back * 1.525;
      return t < 0.5
        ? (2 * t) ** 2 * ((amount + 1) * 2 * t - amount) / 2
        : ((2 * t - 2) ** 2 * ((amount + 1) * (2 * t - 2) + amount) + 2) / 2;
    }
    case "elasticIn": return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * 2 * Math.PI / 3);
    case "elasticOut": return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * 2 * Math.PI / 3) + 1;
    case "elasticInOut": return t < 0.5
      ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * 2 * Math.PI / 4.5)) / 2
      : 2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * 2 * Math.PI / 4.5) / 2 + 1;
    case "bounceIn": return 1 - bounceOut(1 - t);
    case "bounceOut": return bounceOut(t);
    case "bounceInOut": return t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2;
  }
}
