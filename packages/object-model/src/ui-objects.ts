import {
  widgetClassIdForKind,
  type Guid,
  type GuidFactory,
} from "@babylonslate/core";
import { BObject, type LifecycleHooks } from "./objects";

export class UserInterface extends BObject {
  readonly assetGuid: Guid | null;
  readonly widgets: Widget[] = [];

  constructor(options: {
    classId: string;
    guid?: Guid;
    guidFactory?: GuidFactory;
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks;
    implementedInterfaces?: string[];
    assetGuid?: Guid | null;
  }) {
    super(options);
    this.assetGuid = options.assetGuid ?? null;
  }
}

export class Widget extends BObject {
  readonly widgetId: string;
  owner: UserInterface | null;

  constructor(options: {
    classId: string;
    widgetId: string;
    guid?: Guid;
    guidFactory?: GuidFactory;
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks;
    implementedInterfaces?: string[];
    owner?: UserInterface | null;
  }) {
    super(options);
    this.widgetId = options.widgetId;
    this.owner = options.owner ?? null;
  }
}

export class CanvasWidget extends Widget {}
export class HorizontalBoxWidget extends Widget {}
export class VerticalBoxWidget extends Widget {}
export class GridWidget extends Widget {}
export class ScrollBoxWidget extends Widget {}
export class OverlayWidget extends Widget {}
export class SizeBoxWidget extends Widget {}
export class BorderWidget extends Widget {}
export class ButtonWidget extends Widget {}
export class TextWidget extends Widget {}
export class TextInputWidget extends Widget {}
export class SliderWidget extends Widget {}
export class CheckBoxWidget extends Widget {}
export class ImageWidget extends Widget {}
export class MaterialWidget extends Widget {}
export class ProgressBarWidget extends Widget {}
export class SpacerWidget extends Widget {}
export class TouchJoystickWidget extends Widget {}
export class TouchButtonWidget extends Widget {}
export class TouchDPadWidget extends Widget {}
export class UserInterfaceWidget extends Widget {}

type WidgetCtor = new (options: ConstructorParameters<typeof Widget>[0]) => Widget;

const WIDGET_CLASS_BY_KIND: Record<string, WidgetCtor> = {
  Canvas: CanvasWidget,
  HorizontalBox: HorizontalBoxWidget,
  VerticalBox: VerticalBoxWidget,
  Grid: GridWidget,
  ScrollBox: ScrollBoxWidget,
  Overlay: OverlayWidget,
  SizeBox: SizeBoxWidget,
  Border: BorderWidget,
  Button: ButtonWidget,
  Text: TextWidget,
  TextInput: TextInputWidget,
  Slider: SliderWidget,
  CheckBox: CheckBoxWidget,
  Image: ImageWidget,
  Material: MaterialWidget,
  ProgressBar: ProgressBarWidget,
  Spacer: SpacerWidget,
  TouchJoystick: TouchJoystickWidget,
  TouchButton: TouchButtonWidget,
  TouchDPad: TouchDPadWidget,
  UserInterface: UserInterfaceWidget,
};

export function widgetClassForKind(kind: string): WidgetCtor {
  return WIDGET_CLASS_BY_KIND[kind] ?? Widget;
}

export function createWidgetForKind(
  kind: string,
  options: ConstructorParameters<typeof Widget>[0],
): Widget {
  const Ctor = widgetClassForKind(kind);
  return new Ctor({
    ...options,
    classId: options.classId || widgetClassIdForKind(kind),
  });
}
