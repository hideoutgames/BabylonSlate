import {
  NodeParticleBlock,
  NodeParticleBlockConnectionPointTypes,
  type NodeParticleBuildState,
  type NodeParticleConnectionPoint,
  type Particle,
  type ParticleSystem,
} from "@babylonjs/core";
import type { ParticleSpriteSheetSettings } from "@haptic/particle-graph";

type QueueItem = { process: (particle: Particle, system: ParticleSystem) => void; previousItem: QueueItem | null; nextItem: QueueItem | null };
type SheetParticle = Particle & { _properties: Record<string, unknown> };
/** The system as these blocks use it: Babylon 9.29's sheet flag, creation step and update queue. */
type SheetSystem = Pick<ParticleSystem, "spriteCellWidth" | "spriteCellHeight" | "startSpriteCellID" | "endSpriteCellID"
  | "spriteCellLoop" | "spriteRandomStartCell" | "spriteCellChangeSpeed"> & {
  _isAnimationSheetEnabled: boolean;
  _sheetCreation?: QueueItem;
  _updateQueueStart: QueueItem | null;
  /** The Sprite Sheet nearest Emitter Output, which builds last. */
  _slateSpriteSheet?: ParticleSpriteSheetSettings;
};

const sheetSystem = (system: unknown) => system as SheetSystem;

/** The sheet a Sprite Sheet node set on `system`, if any. */
export function particleSpriteSheetOf(system: ParticleSystem): ParticleSpriteSheetSettings | null {
  return sheetSystem(system)._slateSpriteSheet ?? null;
}

/**
 * The cell Animate Sprite Sheet shows `age` seconds into a particle's life that began on
 * `firstCell`: Frames Per Second cells a second from there through End Cell, then round to
 * Start Cell again (Loop) or held on End Cell.
 */
export function animatedSpriteCell(sheet: ParticleSpriteSheetSettings, firstCell: number, age: number): number {
  const count = sheet.endCell - sheet.startCell + 1;
  // A small epsilon keeps whole frames whole after float accumulation of 1/60 s steps.
  const index = firstCell - sheet.startCell + Math.floor(age * sheet.framesPerSecond + 1e-6);
  return sheet.startCell + (sheet.loop ? index % count : Math.min(index, count - 1));
}

function appendUpdate(system: SheetSystem, process: QueueItem["process"]): void {
  const item: QueueItem = { process, previousItem: null, nextItem: null };
  if (!system._updateQueueStart) {
    system._updateQueueStart = item;
    return;
  }
  let last = system._updateQueueStart;
  while (last.nextItem) last = last.nextItem;
  item.previousItem = last;
  last.nextItem = item;
}

/**
 * Sprite Sheet: Babylon's animation sheet (`ANIMATESHEET`), which maps the Material's particle UV
 * onto one cell. Babylon sizes a cell in texels of `particleTexture`, which is the 1 × 1 readiness
 * texture here (the Material samples the real one), so a cell is 1 / Columns × 1 / Rows. The
 * patched particle vertex shader flips V after Babylon's sheet maths, so cell 0 is the top left of
 * a Texture loaded the engine's way (invertY) and each cell is upright. Particles are born on
 * Start Cell or, with Random Start Cell, a random cell from Start Cell to End Cell; Babylon's own
 * age-based cell update is off for node-built systems, so only Animate Sprite Sheet and Update
 * Sprite Cell change it.
 */
export class SlateSpriteSheetBlock extends NodeParticleBlock {
  sheet: ParticleSpriteSheetSettings = {
    columns: 4, rows: 4, startCell: 0, endCell: 15, framesPerSecond: 30, loop: true, randomStartCell: false,
  };

  constructor(name: string) {
    super(name);
    this.registerInput("particle", NodeParticleBlockConnectionPointTypes.Particle);
    this.registerOutput("output", NodeParticleBlockConnectionPointTypes.Particle);
  }

  override getClassName(): string {
    return "SlateSpriteSheetBlock";
  }

  get particle(): NodeParticleConnectionPoint {
    return this._inputs[0]!;
  }

  get output(): NodeParticleConnectionPoint {
    return this._outputs[0]!;
  }

  override _build(state: NodeParticleBuildState): void {
    const built = this.particle.getConnectedValue(state) as ParticleSystem;
    const system = sheetSystem(built);
    const sheet = { ...this.sheet };
    system._isAnimationSheetEnabled = true;
    const creation = system._sheetCreation;
    if (!creation || typeof creation.process !== "function") throw new Error("Unsupported Babylon sprite sheet layout.");
    system.spriteCellWidth = 1 / sheet.columns;
    system.spriteCellHeight = 1 / sheet.rows;
    system.startSpriteCellID = sheet.startCell;
    system.endSpriteCellID = sheet.endCell;
    system.spriteCellLoop = sheet.loop;
    system.spriteRandomStartCell = sheet.randomStartCell;
    system.spriteCellChangeSpeed = 0;
    system._slateSpriteSheet = sheet;
    creation.process = (particle) => {
      const first = sheet.randomStartCell
        ? sheet.startCell + Math.floor(Math.random() * (sheet.endCell - sheet.startCell + 1))
        : sheet.startCell;
      (particle as SheetParticle)._properties.slateSpriteFirstCell = first;
      particle.cellIndex = first;
    };
    this.output._storedValue = built;
  }
}

/** Animate Sprite Sheet: each frame, the cell `animatedSpriteCell` gives for the particle's age. */
export class SlateSpriteAnimateBlock extends NodeParticleBlock {
  constructor(name: string) {
    super(name);
    this.registerInput("particle", NodeParticleBlockConnectionPointTypes.Particle);
    this.registerOutput("output", NodeParticleBlockConnectionPointTypes.Particle);
  }

  override getClassName(): string {
    return "SlateSpriteAnimateBlock";
  }

  get particle(): NodeParticleConnectionPoint {
    return this._inputs[0]!;
  }

  get output(): NodeParticleConnectionPoint {
    return this._outputs[0]!;
  }

  override _build(state: NodeParticleBuildState): void {
    const built = this.particle.getConnectedValue(state) as ParticleSystem;
    const system = sheetSystem(built);
    appendUpdate(system, (particle) => {
      const sheet = system._slateSpriteSheet;
      if (!sheet) return;
      state.particleContext = particle;
      state.systemContext = built;
      const first = (particle as SheetParticle)._properties.slateSpriteFirstCell;
      particle.cellIndex = animatedSpriteCell(sheet, typeof first === "number" ? first : sheet.startCell, particle.age);
    });
    this.output._storedValue = built;
  }
}

/** Update Sprite Cell: the Cell input, rounded down and kept within the sheet. */
export class SlateSpriteCellBlock extends NodeParticleBlock {
  constructor(name: string) {
    super(name);
    this.registerInput("particle", NodeParticleBlockConnectionPointTypes.Particle);
    this.registerInput("cell", NodeParticleBlockConnectionPointTypes.Float, true, 0);
    this.registerOutput("output", NodeParticleBlockConnectionPointTypes.Particle);
  }

  override getClassName(): string {
    return "SlateSpriteCellBlock";
  }

  get particle(): NodeParticleConnectionPoint {
    return this._inputs[0]!;
  }

  get cell(): NodeParticleConnectionPoint {
    return this._inputs[1]!;
  }

  get output(): NodeParticleConnectionPoint {
    return this._outputs[0]!;
  }

  override _build(state: NodeParticleBuildState): void {
    const built = this.particle.getConnectedValue(state) as ParticleSystem;
    const system = sheetSystem(built);
    appendUpdate(system, (particle) => {
      const sheet = system._slateSpriteSheet;
      if (!sheet) return;
      state.particleContext = particle;
      state.systemContext = built;
      const value = Number(this.cell.getConnectedValue(state));
      const cell = Number.isFinite(value) ? Math.floor(value) : 0;
      particle.cellIndex = Math.min(sheet.columns * sheet.rows - 1, Math.max(0, cell));
    });
    this.output._storedValue = built;
  }
}
