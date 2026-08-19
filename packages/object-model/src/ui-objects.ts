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
export class RectangleWidget extends Widget {}
export class StackPanelWidget extends Widget {}
export class HorizontalBoxWidget extends StackPanelWidget {}
export class VerticalBoxWidget extends StackPanelWidget {}
export class GridWidget extends Widget {}
export class ScrollViewerWidget extends Widget {}
export class ScrollBoxWidget extends ScrollViewerWidget {}
export class EllipseWidget extends Widget {}
export class ContainerWidget extends Widget {}
export class OverlayWidget extends RectangleWidget {}
export class SizeBoxWidget extends RectangleWidget {}
export class BorderWidget extends RectangleWidget {}
export class SpacerWidget extends ContainerWidget {}
export class ButtonWidget extends Widget {}
export class TextBlockWidget extends Widget {}
export class TextWidget extends TextBlockWidget {}
export class InputTextWidget extends Widget {}
export class TextInputWidget extends InputTextWidget {}
export class SliderWidget extends Widget {}
export class CheckboxWidget extends Widget {}
export class CheckBoxWidget extends CheckboxWidget {}
export class ImageWidget extends Widget {}
export class MaterialWidget extends Widget {}
export class ProgressBarWidget extends Widget {}
export class TouchJoystickWidget extends Widget {}
export class TouchButtonWidget extends Widget {}
export class TouchDPadWidget extends Widget {}
export class UserInterfaceWidget extends Widget {}

type WidgetCtor = new (options: ConstructorParameters<typeof Widget>[0]) => Widget;

const WIDGET_CLASS_BY_KIND: Record<string, WidgetCtor> = {
  Canvas: CanvasWidget,
  Rectangle: RectangleWidget,
  StackPanel: StackPanelWidget,
  HorizontalBox: StackPanelWidget,
  VerticalBox: StackPanelWidget,
  Grid: GridWidget,
  ScrollViewer: ScrollViewerWidget,
  ScrollBox: ScrollViewerWidget,
  Ellipse: EllipseWidget,
  Container: ContainerWidget,
  Overlay: RectangleWidget,
  SizeBox: RectangleWidget,
  Border: RectangleWidget,
  Spacer: ContainerWidget,
  Button: ButtonWidget,
  TextBlock: TextBlockWidget,
  Text: TextBlockWidget,
  InputText: InputTextWidget,
  TextInput: InputTextWidget,
  Slider: SliderWidget,
  Checkbox: CheckboxWidget,
  CheckBox: CheckboxWidget,
  Image: ImageWidget,
  Material: MaterialWidget,
  ProgressBar: ProgressBarWidget,
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
