import type { ReactElement } from "react";
import { FunctionIcon } from "@phosphor-icons/react/dist/csr/Function";
import { UserFocusIcon } from "@phosphor-icons/react/dist/csr/UserFocus";
import { IconRun, IconSphere, IconSquareLetterE, IconVariable } from "@tabler/icons-react";
import {
  ArrowUpFromLineIcon,
  BlendIcon,
  BoneIcon,
  CircleDotIcon,
  CirclePlusIcon,
  ClockIcon,
  CodeXmlIcon,
  Columns3Icon,
  FlameIcon,
  FlipHorizontal2Icon,
  Gamepad2Icon,
  GitCommitHorizontalIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  ListOrderedIcon,
  PersonStandingIcon,
  PlayIcon,
  PlugIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  RepeatIcon,
  RouteIcon,
  Settings2Icon,
  ShapesIcon,
  SplitIcon,
  SquareFunctionIcon,
  type LucideIcon,
} from "lucide-react";
import ImageGlyph from "react-bootstrap-icons/dist/icons/image";
import { cn } from "@haptic/ui/lib/utils";
import type { NodeKind } from "./node-theme";

type Glyph = (props: { className?: string }) => ReactElement;

const lucide = (Icon: LucideIcon): Glyph =>
  function LucideGlyph({ className }) {
    return <Icon className={className} aria-hidden="true" />;
  };

const tabler = (Icon: typeof IconRun): Glyph =>
  function TablerGlyph({ className }) {
    return <Icon className={className} stroke={2} aria-hidden="true" />;
  };

/** Phosphor's bold weight matches Lucide's 2px stroke at 24px. */
const PureGlyph: Glyph = ({ className }) => <FunctionIcon className={className} weight="bold" aria-hidden="true" />;

/** The Pose pin glyph, as published (regular weight). */
const PoseGlyph: Glyph = ({ className }) => <UserFocusIcon className={className} weight="regular" aria-hidden="true" />;

/** The Frame pin glyph. Bootstrap fills its whole box, so it is drawn smaller to sit with padded icons. */
const FrameGlyph: Glyph = ({ className }) => <ImageGlyph className={cn(className, "scale-[0.85]")} aria-hidden="true" />;

/**
 * The icon and accessible name for each `NodeKind`. Icons come from the
 * approved sets only (Lucide, Phosphor, Bootstrap, Tabler), used as published.
 */
const NODE_KIND_ICON: Record<NodeKind, { Icon: Glyph; label: string }> = {
  event: { Icon: tabler(IconSquareLetterE), label: "Event" },
  "input-event": { Icon: lucide(Gamepad2Icon), label: "Input Event" },
  function: { Icon: lucide(SquareFunctionIcon), label: "Function" },
  pure: { Icon: PureGlyph, label: "Pure Function" },
  latent: { Icon: lucide(ClockIcon), label: "Latent Function" },
  interface: { Icon: lucide(PlugIcon), label: "Interface Function" },
  dispatcher: { Icon: lucide(RadioTowerIcon), label: "Event Dispatcher" },
  "call-event": { Icon: lucide(RadioTowerIcon), label: "Call Event" },
  "call-parent": { Icon: lucide(ArrowUpFromLineIcon), label: "Call Parent" },
  flow: { Icon: lucide(SplitIcon), label: "Flow Control" },
  loop: { Icon: lucide(RepeatIcon), label: "Loop" },
  variable: { Icon: tabler(IconVariable), label: "Variable" },
  "material-output": { Icon: tabler(IconSphere), label: "Material Output" },
  operation: { Icon: PureGlyph, label: "Operation" },
  constant: { Icon: lucide(HashIcon), label: "Constant" },
  parameter: { Icon: lucide(Settings2Icon), label: "Parameter" },
  input: { Icon: tabler(IconVariable), label: "Input" },
  texture: { Icon: lucide(ImageIcon), label: "Texture" },
  "custom-code": { Icon: lucide(CodeXmlIcon), label: "Custom Code" },
  "emitter-output": { Icon: lucide(FlameIcon), label: "Emitter Output" },
  create: { Icon: lucide(CirclePlusIcon), label: "Create" },
  shape: { Icon: lucide(ShapesIcon), label: "Shape" },
  update: { Icon: lucide(RefreshCwIcon), label: "Update" },
  player: { Icon: tabler(IconRun), label: "Player" },
  blend: { Icon: lucide(BlendIcon), label: "Blend" },
  select: { Icon: lucide(SplitIcon), label: "Select" },
  "rest-pose": { Icon: lucide(PersonStandingIcon), label: "Rest Pose" },
  flip: { Icon: lucide(FlipHorizontal2Icon), label: "Flip" },
  "skeletal-control": { Icon: lucide(BoneIcon), label: "Skeletal Control" },
  "output-pose": { Icon: PoseGlyph, label: "Output Pose" },
  "output-frame": { Icon: FrameGlyph, label: "Output Frame" },
  state: { Icon: lucide(CircleDotIcon), label: "State" },
  "state-alias": { Icon: lucide(LinkIcon), label: "State Alias" },
  "bt-selector": { Icon: lucide(SplitIcon), label: "Selector" },
  "bt-sequence": { Icon: lucide(ListOrderedIcon), label: "Sequence" },
  "bt-parallel": { Icon: lucide(Columns3Icon), label: "Parallel" },
  "bt-task": { Icon: lucide(PlayIcon), label: "Task" },
  reroute: { Icon: lucide(GitCommitHorizontalIcon), label: "Reroute" },
  namedReroute: { Icon: lucide(RouteIcon), label: "Named Reroute" },
};

/**
 * A node's kind icon, left of its title: an image named for the kind
 * (`Latent Function`, `Event Dispatcher`). `decorative` hides it from
 * assistive technology where the kind is not news (Add Node rows).
 */
export function NodeKindIcon({
  kind,
  className,
  decorative = false,
}: {
  kind: NodeKind;
  className?: string;
  decorative?: boolean;
}) {
  const { Icon, label } = NODE_KIND_ICON[kind];
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? "true" : undefined}
      data-node-kind={kind}
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
    >
      <Icon className="size-full" />
    </span>
  );
}
