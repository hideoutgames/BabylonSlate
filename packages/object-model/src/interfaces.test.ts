import { describe, expect, it } from "vitest";
import {
  InterfaceRegistry,
  dispatchInterface,
  interfaceHandlerKey,
} from "./interfaces";
import { Actor } from "./objects";

describe("ScriptInterface dispatch", () => {
  it("returns pin defaults when the target does not implement the interface", () => {
    const interfaces = new InterfaceRegistry();
    interfaces.register({
      guid: "iface-damageable",
      name: "Damageable",
      methods: [
        {
          name: "ApplyDamage",
          outputs: { applied: false, remaining: 0, hitAt: { x: 0, y: 0, z: 0 } },
        },
      ],
    });

    const target = new Actor({
      classId: "Actor",
      guid: "a1",
      implementedInterfaces: [],
    });

    const dispatch = () => dispatchInterface(
      interfaces,
      target,
      "iface-damageable",
      "ApplyDamage",
      { amount: 10 },
    );
    const result = dispatch();
    expect(result).toEqual({ applied: false, remaining: 0, hitAt: { x: 0, y: 0, z: 0 } });
    // Each dispatch owns its defaults: editing one result never leaks into the next.
    (result.hitAt as { x: number }).x = 5;
    expect(dispatch().hitAt).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("invokes a registered handler when implemented", () => {
    const interfaces = new InterfaceRegistry();
    interfaces.register({
      guid: "iface-damageable",
      name: "Damageable",
      methods: [
        {
          name: "ApplyDamage",
          outputs: { applied: false, remaining: 0 },
        },
      ],
    });

    const target = new Actor({
      classId: "Enemy",
      guid: "enemy-1",
      variables: { health: 50 },
      implementedInterfaces: ["iface-damageable"],
    });
    target.interfaceHandlers.set(
      interfaceHandlerKey("iface-damageable", "ApplyDamage"),
      (args) => {
        const amount = Number(args.amount ?? 0);
        const health = Number(target.getVariable("health") ?? 0) - amount;
        target.setVariable("health", health);
        return { applied: true, remaining: health };
      },
    );

    const result = dispatchInterface(
      interfaces,
      target,
      "iface-damageable",
      "ApplyDamage",
      { amount: 15 },
    );
    expect(result).toEqual({ applied: true, remaining: 35 });
    expect(target.getVariable("health")).toBe(35);
  });
});
