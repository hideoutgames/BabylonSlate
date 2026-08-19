import { ViewportJoystick } from "./viewport-joystick";

export type PlayFreeCamJoystickProps = {
  enabled: boolean;
  onFly: (forward: number, right: number) => void;
};

/** On-screen fly stick while Preview free cam is on. Isolates pointers from look. */
export function PlayFreeCamJoystick({
  enabled,
  onFly,
}: PlayFreeCamJoystickProps) {
  if (!enabled) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-start p-4"
      data-testid="play-freecam-joystick"
    >
      <div className="pointer-events-auto">
        <ViewportJoystick onFly={onFly} />
      </div>
    </div>
  );
}
