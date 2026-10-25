import type { LineTraceOptions, parseRigidBodyProperties } from "@haptic/physics";
import type { Actor } from "@haptic/object-model";
import { COLLISION_CHANNEL_MEMBERS } from "@haptic/scripting";
import type { MovementDrive } from "./physics-body-classification";

/** What `PhysicsQueryChannels` uses of `PhysicsWorldSync`. */
export interface QueryChannelHost {
  /** The bound World's `structuralRevision`; 0 before one is bound. */
  structuralRevision(): number;
  /** The motion type last applied to an actor's body; undefined without a body. */
  motionOf(actorId: string): ReturnType<typeof parseRigidBodyProperties>["motionType"] | undefined;
  movementDrive(actor: Actor): MovementDrive | undefined;
  /** The actor each body was created for, by actor guid. */
  readonly bodyOwners: ReadonlyMap<string, Actor>;
  /** Hosts by hosted actor guid. Read at each use: every pass swaps the map. */
  hosts(): ReadonlyMap<string, Actor>;
  /** Actors whose ordinary body an active ragdoll replaced, by guid. */
  readonly ragdollActors: ReadonlyMap<string, Actor>;
}

/**
 * What the All, Static, Dynamic, Character, Solid and Triggers query channels
 * mean, and the cached ignore lists behind Static, Dynamic and Character.
 */
export class PhysicsQueryChannels {
  private readonly host: QueryChannelHost;
  /** Channel names already reported as unknown (`warnUnknownChannel`). */
  private readonly unknownChannels = new Set<string>();
  /**
   * Each Static, Dynamic or Character query's ignore list, kept until something it derives from changes:
   * `channelEpoch` for body creation and retirement, a motion change, hosting and ragdolls (`invalidate`), and
   * for Character the World's `structuralRevision`, which a Movement component joining or leaving bumps.
   */
  private readonly channelIgnores = new Map<string, { epoch: number; revision: number; ids: readonly string[] }>();
  private channelEpoch = 0;
  private channelRebuilds = 0;

  constructor(host: QueryChannelHost) {
    this.host = host;
  }

  /** How many times a channel's ignore list was built, so a test can tell a reused list from a rebuilt one. */
  get builds(): number {
    return this.channelRebuilds;
  }

  /** The bodies, hosting, motion types or ragdolls behind the channels' ignore lists changed. */
  invalidate(): void {
    this.channelEpoch++;
  }

  /** Drops the cached ignore lists (`PhysicsWorldSync.dispose`). */
  clearCache(): void {
    this.channelIgnores.clear();
  }

  /** The backend's options for a query on `options.channel`, whose meaning lives here and nowhere else. */
  options(options?: LineTraceOptions & { channel?: string }): LineTraceOptions | undefined {
    const channel = options?.channel;
    if (!channel) return options;
    switch (channel) {
      case "All":
        return options;
      case "Solid":
        return { ...options, includeTriggers: false };
      case "Triggers":
        // Every backend filters trigger shapes itself, before the hit is chosen.
        return { ...options, onlyTriggers: true };
      case "Static":
      case "Dynamic":
      case "Character": {
        const ids = this.channelIgnoreList(channel);
        if (!ids.length) return options;
        const own = options?.ignoreActorIds;
        return { ...options, ignoreActorIds: own?.length ? [...own, ...ids] : ids };
      }
      default:
        this.warnUnknownChannel(channel);
        return options;
    }
  }

  /**
   * A name that is no channel (a graph saved before the channels were renamed) is answered as All. It is reported
   * once per name, so a query that runs every frame does not flood the console.
   */
  private warnUnknownChannel(channel: string): void {
    const name = String(channel);
    if (this.unknownChannels.has(name)) return;
    this.unknownChannels.add(name);
    console.warn(`[physics] Unknown collision channel "${name}": the query behaves as All. Use ${COLLISION_CHANNEL_MEMBERS.join(", ")}.`);
  }

  /**
   * The actors a Static, Dynamic or Character query ignores, from the bodies, hosting and ragdolls as they stand.
   * Built on the first query after any of them changed (`invalidate`, plus the World's structure for
   * Character, whose Movement component has no hook) and reused until then, so a query walks no bodies.
   */
  private channelIgnoreList(channel: "Static" | "Dynamic" | "Character"): readonly string[] {
    const revision = channel === "Character" ? this.host.structuralRevision() : 0;
    const cached = this.channelIgnores.get(channel);
    if (cached && cached.epoch === this.channelEpoch && cached.revision === revision) return cached.ids;
    this.channelRebuilds++;
    const ignored = new Set<string>();
    const matches = (actor: Actor) => {
      const motion = this.host.motionOf(actor.guid) ?? "static";
      return channel === "Static" ? motion === "static"
        : channel === "Dynamic" ? motion !== "static" : this.host.movementDrive(actor) !== undefined;
    };
    const hosts = this.host.hosts();
    for (const [actorId, actor] of this.host.bodyOwners)
      if (!hosts.has(actorId) && !matches(actor)) ignored.add(actorId);
    // Hosted shapes, and a hosted actor's own triggers, answer as their host.
    for (const [actorId, host] of hosts)
      if (!matches(host)) ignored.add(actorId);
    // An active ragdoll's bones are dynamic and no Movement drives them: Dynamic (and All) keep them.
    if (channel !== "Dynamic") for (const actorId of this.host.ragdollActors.keys()) ignored.add(actorId);
    const ids = Object.freeze([...ignored]);
    this.channelIgnores.set(channel, { epoch: this.channelEpoch, revision, ids });
    return ids;
  }
}
