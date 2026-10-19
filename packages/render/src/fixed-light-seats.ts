import {
  FIXED_LIGHT_KINDS,
  type FixedLightKind,
  type FixedLightLayout,
  type FixedLightShadowKind,
} from "@babylonslate/core";

/** One light the fixed layout may seat, as admission sees it. */
export interface FixedSeatCandidate<L> {
  readonly light: L;
  readonly kind: FixedLightKind;
  /** The kind of shadow map the shadow controller admitted for the light (standby maps excluded), or null. */
  readonly map: FixedLightShadowKind | null;
  /** The light counts against the scalability local-light budget. */
  readonly local: boolean;
}

/** One seat of the slot table. */
export interface FixedLightSeat<L> {
  readonly classId: string;
  /** Seat index within its class. */
  readonly index: number;
  readonly light: L | null;
  /** The light samples its admitted shadow map in this seat. */
  readonly shadowActive: boolean;
}

/** Why admission left a light out: no seat for its kind, the scalability local lights, or the bound textures' samplers. */
export type FixedLightLimit = "seats" | "localBudget" | "samplers";

export interface FixedSeatAssignment<L> {
  /** Every seat of the layout in canonical class order. */
  readonly seats: FixedLightSeat<L>[];
  readonly admitted: L[];
  readonly limited: { light: L; reason: FixedLightLimit }[];
}

const kindBit = (kind: FixedLightKind) => 1 << FIXED_LIGHT_KINDS.indexOf(kind);

/**
 * Admits `ranked` (best first) and seats it in `layout`.
 *
 * Admission takes lights in rank order while every admitted light can still
 * have a seat (checked over each set of kinds, so classes that share kinds
 * stay correct), within `maxLights`, the local-light budget and `accept` (the
 * sampler headroom of textures the light binds).
 *
 * Seating: a light keeps its previous seat while that class still hosts its
 * kind. A light holding a shadow map then takes a seat in a shadow class of
 * that map's kind: a free one, else one whose light has no such map, which
 * moves. The rest take free seats in classes without shadow seating, then free
 * shadow-class seats with the shadow off. A seat's shadow is active only for
 * a light whose map matches the class's.
 */
export function assignFixedLightSeats<L>(
  layout: FixedLightLayout,
  ranked: readonly FixedSeatCandidate<L>[],
  previous: readonly FixedLightSeat<L>[],
  options: {
    maxLights: number;
    localBudget: number;
    accept?: (candidate: FixedSeatCandidate<L>) => boolean;
  },
): FixedSeatAssignment<L> {
  const classes = layout.classes;
  const hostMasks = classes.map((entry) => entry.hosts.reduce((mask, kind) => mask | kindBit(kind), 0));
  const fullMask = (1 << FIXED_LIGHT_KINDS.length) - 1;
  // Seats any light of a kind in `mask` could take.
  const seatsFor = new Array<number>(fullMask + 1).fill(0);
  for (let mask = 1; mask <= fullMask; mask++)
    for (let index = 0; index < classes.length; index++)
      if (hostMasks[index]! & mask) seatsFor[mask]! += classes[index]!.seats;
  const counts = FIXED_LIGHT_KINDS.map(() => 0);
  // Hall's condition: every set of kinds holds no more admitted lights than seats hosting them.
  const seatable = (kind: FixedLightKind) => {
    const bit = kindBit(kind);
    for (let mask = 1; mask <= fullMask; mask++) {
      if (!(mask & bit)) continue;
      let demand = 1;
      for (let index = 0; index < counts.length; index++) if (mask & (1 << index)) demand += counts[index]!;
      if (demand > seatsFor[mask]!) return false;
    }
    return true;
  };

  const admitted: FixedSeatCandidate<L>[] = [];
  const limited: { light: L; reason: FixedLightLimit }[] = [];
  let locals = 0;
  for (const candidate of ranked) {
    if (admitted.length >= options.maxLights || !seatable(candidate.kind))
      limited.push({ light: candidate.light, reason: "seats" });
    else if (candidate.local && locals >= options.localBudget)
      limited.push({ light: candidate.light, reason: "localBudget" });
    else if (options.accept && !options.accept(candidate))
      limited.push({ light: candidate.light, reason: "samplers" });
    else {
      admitted.push(candidate);
      counts[FIXED_LIGHT_KINDS.indexOf(candidate.kind)]! += 1;
      if (candidate.local) locals++;
    }
  }

  const offsets: number[] = [];
  let total = 0;
  for (const entry of classes) {
    offsets.push(total);
    total += entry.seats;
  }
  const occupants: (FixedSeatCandidate<L> | null)[] = new Array(total).fill(null);
  const placed = new Map<L, number>();
  const classOf = (seat: number) => {
    let index = 0;
    while (index + 1 < classes.length && offsets[index + 1]! <= seat) index++;
    return index;
  };
  const hosts = (candidate: FixedSeatCandidate<L>, index: number) => (hostMasks[index]! & kindBit(candidate.kind)) !== 0;
  const shadowMatches = (candidate: FixedSeatCandidate<L>, index: number) =>
    candidate.map !== null && classes[index]!.shadow === candidate.map;
  const place = (candidate: FixedSeatCandidate<L>, seat: number) => {
    const from = placed.get(candidate.light);
    if (from !== undefined) occupants[from] = null;
    occupants[seat] = candidate;
    placed.set(candidate.light, seat);
  };
  const freeSeat = (candidate: FixedSeatCandidate<L>, accept: (index: number) => boolean) => {
    for (let index = 0; index < classes.length; index++) {
      if (!hosts(candidate, index) || !accept(index)) continue;
      for (let seat = offsets[index]!; seat < offsets[index]! + classes[index]!.seats; seat++)
        if (!occupants[seat]) return seat;
    }
    return -1;
  };

  // Previous seats that are still legal. A light that sampled its shadow in
  // its seat and still holds that map keeps it against every other light.
  const prior = new Map<L, { classId: string; index: number; shadowActive: boolean }>();
  for (const seat of previous) if (seat.light !== null) prior.set(seat.light, seat);
  const rank = new Map<L, number>();
  const kept = new Set<L>();
  admitted.forEach((candidate, order) => rank.set(candidate.light, order));
  for (const candidate of admitted) {
    const seat = prior.get(candidate.light);
    if (!seat) continue;
    const index = classes.findIndex((entry) => entry.id === seat.classId);
    if (index < 0 || seat.index >= classes[index]!.seats || !hosts(candidate, index)) continue;
    place(candidate, offsets[index]! + seat.index);
    if (seat.shadowActive && shadowMatches(candidate, index)) kept.add(candidate.light);
  }
  // Other lights holding a map take a seat of their map's shadow class in rank
  // order: a free one, else one whose light has no such map or ranks lower and
  // did not hold its shadow there; that light moves.
  const shadowSeat = (index: number) => classes[index]!.shadowClass;
  const pending = admitted.filter((candidate) => candidate.map !== null && !kept.has(candidate.light));
  // Each move seats a light in a matching seat or a higher-ranked one in place of a lower; the bound is a backstop.
  for (let moves = 0; pending.length && moves < admitted.length * (total + 1); moves++) {
    const candidate = pending.shift()!;
    const current = placed.get(candidate.light);
    if (current !== undefined && shadowMatches(candidate, classOf(current))) continue;
    const wanted = (index: number) => shadowSeat(index) && shadowMatches(candidate, index);
    let seat = freeSeat(candidate, wanted);
    for (let index = 0; seat < 0 && index < classes.length; index++) {
      if (!hosts(candidate, index) || !wanted(index)) continue;
      for (let slot = offsets[index]!; slot < offsets[index]! + classes[index]!.seats; slot++) {
        const occupant = occupants[slot]!;
        if (kept.has(occupant.light)) continue;
        if (shadowMatches(occupant, index) && rank.get(occupant.light)! < rank.get(candidate.light)!) continue;
        placed.delete(occupant.light);
        // A displaced light that holds a map looks for another shadow seat.
        if (occupant.map !== null) pending.push(occupant);
        seat = slot;
        break;
      }
    }
    if (seat >= 0) place(candidate, seat);
  }
  // Everything else: classes without shadow seating first, then free shadow seats with the shadow off.
  const seated: L[] = [];
  for (const candidate of admitted) {
    if (!placed.has(candidate.light)) {
      let seat = freeSeat(candidate, (index) => !shadowSeat(index));
      if (seat < 0) seat = freeSeat(candidate, shadowSeat);
      if (seat < 0) {
        limited.push({ light: candidate.light, reason: "seats" });
        continue;
      }
      place(candidate, seat);
    }
    seated.push(candidate.light);
  }

  const seats: FixedLightSeat<L>[] = [];
  for (let index = 0; index < classes.length; index++)
    for (let seat = 0; seat < classes[index]!.seats; seat++) {
      const occupant = occupants[offsets[index]! + seat] ?? null;
      seats.push({
        classId: classes[index]!.id,
        index: seat,
        light: occupant?.light ?? null,
        shadowActive: occupant !== null && shadowMatches(occupant, index),
      });
    }
  return { seats, admitted: seated, limited };
}
