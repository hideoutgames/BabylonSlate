import {
  SaveGameError,
  cloneSaveGameValue,
  createSaveGameData,
  isSaveGameRecord,
  validateSaveGameDefinition,
  validateSaveGameFieldValue,
  validateSaveGameValue,
  type SaveGameDefinition,
  type SaveGameFailure,
  type SaveGameInfo,
  type SaveGameMigration,
  type SaveGameMigrationData,
  type SaveGameOptions,
  type SaveGameResult,
  type SaveGameServiceOptions,
  type SaveGameValue,
} from "./save-game";

const FORMAT_VERSION = 1;
const MAX_SAVE_BYTES = 16 * 1024 * 1024;
const generationNames = ["generation-a.save", "generation-b.save"] as const;
interface SaveBody extends SaveGameMigrationData {
  formatVersion: number;
  projectId: string;
  definitionId: string;
  profile: string;
  slot: string;
  sequence: number;
  createdAt: string;
}
interface Candidate { index: number; text: string; body: SaveBody }
interface SlotRead { latest: Candidate | null; recovered: boolean }
interface Address { profile: string; slot: string; prefix: string }

function segment(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SaveGameError("invalid", "Project, profile and slot IDs must not be empty.");
  let encoded: string;
  try { encoded = encodeURIComponent(value); } catch { throw new SaveGameError("invalid", "Save IDs must contain valid Unicode."); }
  if (encoded.length > 120) throw new SaveGameError("invalid", "A project, profile or slot ID is too long.");
  return encoded;
}

function failure(error: unknown): SaveGameFailure {
  if (error instanceof SaveGameError) return { code: error.code, message: error.message };
  const record = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (record?.name === "QuotaExceededError" || record?.name === "StorageFullError" || record?.code === "ENOSPC" || record?.code === "EDQUOT") return { code: "storage-full", message: "There is not enough storage to save the game. The previous save is preserved." };
  return { code: "unavailable", message: typeof record?.message === "string" ? record.message : "Save storage is unavailable." };
}

async function checksum(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new SaveGameError("unavailable", "Save games require a secure context with Web Crypto support.");
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_SAVE_BYTES) throw new SaveGameError("invalid", "Save data exceeds the 16 MiB limit.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Shared by editor Play and exported games; no platform or scene dependencies. */
export class SaveGameService<TData extends object = Record<string, SaveGameValue>> {
  readonly definition: SaveGameDefinition;
  readonly projectId: string;
  readonly preview: boolean;
  private readonly options: SaveGameServiceOptions<TData>;
  private readonly root: string;
  private readonly data: TData;
  private readonly migrations = new Map<number, SaveGameMigration>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: SaveGameServiceOptions<TData>) {
    this.definition = validateSaveGameDefinition(options.definition);
    this.projectId = options.projectId;
    this.preview = options.preview === true;
    this.root = `save-games/${segment(options.projectId)}/${this.preview ? "preview" : "game"}`;
    segment(options.defaultProfile ?? "default");
    segment(options.defaultSlot ?? "default");
    this.options = options;
    this.data = createSaveGameData(this.definition) as TData;
  }

  /** Stable object identity across loads; only declared fields are persisted. */
  getSaveData(): TData { return this.data; }

  getField(fieldId: string): SaveGameValue {
    const field = this.definition.fields.find((entry) => entry.id === fieldId);
    if (!field) throw new SaveGameError("invalid", `Unknown save field: ${fieldId}`);
    return (this.data as Record<string, SaveGameValue>)[field.name];
  }

  setField(fieldId: string, value: SaveGameValue): void {
    const field = this.definition.fields.find((entry) => entry.id === fieldId);
    if (!field) throw new SaveGameError("invalid", `Unknown save field: ${fieldId}`);
    (this.data as Record<string, SaveGameValue>)[field.name] = validateSaveGameFieldValue(field, value);
  }

  registerMigration(fromVersion: number, migrate: SaveGameMigration): void {
    if (!Number.isSafeInteger(fromVersion) || fromVersion < 1 || fromVersion >= this.definition.schemaVersion || typeof migrate !== "function") throw new SaveGameError("invalid", "A migration must start at an older positive schema version.");
    if (this.migrations.has(fromVersion)) throw new SaveGameError("invalid", `A migration from version ${fromVersion} is already registered.`);
    this.migrations.set(fromVersion, migrate);
  }

  newGame(): Promise<SaveGameResult<TData>> {
    return this.run(async () => {
      const defaults = createSaveGameData(this.definition);
      await this.boundary(async () => {
        try { await this.options.resetState?.(); } catch (error) { throw error instanceof SaveGameError ? error : new SaveGameError("apply-failed", "The game could not be reset."); }
        this.replaceData(defaults);
      });
      return this.data;
    }, false);
  }

  saveGame(options: SaveGameOptions = {}): Promise<SaveGameResult<SaveGameInfo>> {
    return this.run(async () => {
      const address = this.address(options);
      const existing = await this.readSlot(address);
      if (existing.latest) this.restoreFields((await this.migrate(existing.latest.body)).fields);
      const captured = await this.boundary(async () => {
        const fields = this.captureFields();
        const state = cloneSaveGameValue(await this.options.captureState?.() ?? null);
        return { fields, state };
      });
      return this.commit(address, captured, existing);
    });
  }

  loadGame(options: SaveGameOptions = {}): Promise<SaveGameResult<SaveGameInfo>> {
    return this.run(async () => {
      const address = this.address(options);
      const existing = await this.readSlot(address);
      if (!existing.latest) throw new SaveGameError("missing", "No save exists in this slot.");
      const migrated = await this.migrate(existing.latest.body);
      const data = this.restoreFields(migrated.fields);
      let staged: unknown;
      try { staged = this.options.stageState ? await this.options.stageState(migrated.state, data as TData) : migrated.state; }
      catch (error) { throw error instanceof SaveGameError ? error : new SaveGameError("corrupt", "Saved gameplay state could not be staged."); }
      const info = this.info(existing.latest.body, existing.recovered);
      await this.boundary(async () => {
        try { await this.options.applyState?.(staged); }
        catch (error) { throw error instanceof SaveGameError ? error : new SaveGameError("apply-failed", "Saved gameplay state could not be applied."); }
        this.replaceData(data);
        // Notification failures must not report an already applied load as failed.
        try { this.options.onGameLoaded?.(info, this.data); } catch { /* Game callback errors are owned by the script host. */ }
      });
      return info;
    });
  }

  listSaves(options: { profile?: string } = {}): Promise<SaveGameResult<SaveGameInfo[]>> {
    return this.run(async () => {
      const profile = options.profile ?? this.options.defaultProfile ?? "default";
      const prefix = `${this.root}/${segment(profile)}/`;
      const keys = await this.options.storage.list(prefix);
      const slots = new Set<string>();
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        const parts = key.slice(prefix.length).split("/");
        if (parts.length !== 2 || !generationNames.includes(parts[1] as typeof generationNames[number])) continue;
        try { slots.add(decodeURIComponent(parts[0])); } catch { /* Ignore foreign files. */ }
      }
      const result: SaveGameInfo[] = [];
      for (const slot of [...slots].sort()) {
        const address = this.address({ profile, slot });
        try {
          const saved = await this.readSlot(address);
          if (saved.latest) {
            const info = this.info(saved.latest.body, saved.recovered);
            try { this.assertCompatible(saved.latest.body); }
            catch (error) { info.status = "incompatible"; info.error = failure(error); }
            result.push(info);
          }
        } catch (error) {
          const cause = failure(error);
          if (cause.code !== "corrupt" && cause.code !== "incompatible") throw error;
          result.push({ projectId: this.projectId, profile, slot, definitionId: this.definition.id, schemaVersion: 0, sequence: 0, createdAt: "", recovered: false, status: cause.code, error: cause });
        }
      }
      return result;
    });
  }

  deleteSave(options: SaveGameOptions = {}): Promise<SaveGameResult<void>> {
    return this.run(async () => this.removePrefix(`${this.address(options).prefix}/`));
  }

  /** Used by editor tools. No profile means this project's entire mode namespace. */
  resetLocalSaves(options: { profile?: string } = {}): Promise<SaveGameResult<void>> {
    return this.run(async () => this.removePrefix(options.profile === undefined ? `${this.root}/` : `${this.root}/${segment(options.profile)}/`));
  }

  /** Explicit guard for editor automation: exported-game data cannot be wiped here. */
  resetPreviewData(): Promise<SaveGameResult<void>> {
    if (!this.preview) return Promise.resolve({ ok: false, error: { code: "invalid", message: "Only editor-preview saves may be reset by this action." } });
    return this.resetLocalSaves();
  }

  exportSave(options: SaveGameOptions = {}): Promise<SaveGameResult<string>> {
    return this.run(async () => {
      const saved = await this.readSlot(this.address(options));
      if (!saved.latest) throw new SaveGameError("missing", "No save exists in this slot.");
      return saved.latest.text;
    });
  }

  /** Validate before writing; importing does not change the running game. */
  importSave(text: string, options: SaveGameOptions = {}): Promise<SaveGameResult<SaveGameInfo>> {
    return this.run(async () => {
      const imported = await this.decode(text);
      const migrated = await this.migrate(imported);
      const data = this.restoreFields(migrated.fields);
      if (this.options.stageState) {
        try { await this.options.stageState(migrated.state, data as TData); }
        catch (error) { throw error instanceof SaveGameError ? error : new SaveGameError("corrupt", "Imported gameplay state could not be staged."); }
      }
      const address = this.address(options);
      const existing = await this.readSlot(address);
      if (existing.latest) this.assertCompatible(existing.latest.body);
      // Keep the imported original if migrating, independently of the destination.
      if (imported.schemaVersion !== this.definition.schemaVersion) await this.archive(address, imported, text);
      return this.commit(address, migrated, existing);
    });
  }

  requestPersistence(): Promise<SaveGameResult<boolean>> {
    return this.run(async () => this.options.storage.requestPersistence ? this.options.storage.requestPersistence() : false, false);
  }

  private run<T>(operation: () => Promise<T>, locked = true): Promise<SaveGameResult<T>> {
    const pending = this.queue.then(async (): Promise<SaveGameResult<T>> => {
      try {
        const value = locked ? await this.options.storage.withLock(this.root, operation) : await operation();
        return { ok: true, value };
      } catch (error) { return { ok: false, error: failure(error) }; }
    });
    this.queue = pending;
    return pending;
  }

  private boundary<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.options.atBoundary ? this.options.atBoundary(operation) : Promise.resolve().then(operation);
  }

  private address(options: SaveGameOptions): Address {
    const profile = options.profile ?? this.options.defaultProfile ?? "default";
    const slot = options.slot ?? this.options.defaultSlot ?? "default";
    return { profile, slot, prefix: `${this.root}/${segment(profile)}/${segment(slot)}` };
  }

  private captureFields(): Record<string, SaveGameValue> {
    const record = this.data as Record<string, unknown>;
    return Object.fromEntries(this.definition.fields.map((field) => [field.id, validateSaveGameFieldValue(field, record[field.name])]));
  }

  private restoreFields(fields: Record<string, SaveGameValue>): Record<string, SaveGameValue> {
    return Object.fromEntries(this.definition.fields.map((field) => {
      try { return [field.name, validateSaveGameFieldValue(field, Object.hasOwn(fields, field.id) ? fields[field.id] : field.defaultValue)]; }
      catch { throw new SaveGameError("incompatible", `Saved field “${field.name}” needs a schema migration to ${field.type}${field.array ? "[]" : ""}.`); }
    }));
  }

  private replaceData(data: Record<string, SaveGameValue>): void {
    const current = this.data as Record<string, SaveGameValue>;
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, data);
  }

  private assertCompatible(body: SaveBody): void {
    if (body.projectId !== this.projectId) throw new SaveGameError("incompatible", "This save belongs to a different project.");
    if (body.definitionId !== this.definition.id) throw new SaveGameError("incompatible", "This save uses a different Save Game definition.");
    if (body.schemaVersion > this.definition.schemaVersion) throw new SaveGameError("incompatible", "This save was created by a newer game schema.");
  }

  private async migrate(body: SaveBody): Promise<SaveGameMigrationData> {
    this.assertCompatible(body);
    let data = cloneSaveGameValue({ schemaVersion: body.schemaVersion, fields: body.fields, state: body.state }) as unknown as SaveGameMigrationData;
    const steps = [...this.migrations].filter(([from]) => from >= body.schemaVersion && from < this.definition.schemaVersion).sort(([a], [b]) => a - b);
    if (steps.length > 0 && (steps.length !== this.definition.schemaVersion - body.schemaVersion || steps.some(([from], index) => from !== body.schemaVersion + index))) {
      throw new SaveGameError("incompatible", "The save schema needs a complete migration chain. Register every intermediate step, including explicit no-op steps.");
    }
    for (const [from, migrate] of steps) {
      data.schemaVersion = from;
      try {
        data = await migrate(data) ?? data;
        if (!isSaveGameRecord(data) || !isSaveGameRecord(data.fields) || !Object.hasOwn(data, "state")) throw new Error("Invalid migration data.");
        data = cloneSaveGameValue(data) as unknown as SaveGameMigrationData;
        data.schemaVersion = from + 1;
      } catch (error) { throw error instanceof SaveGameError ? error : new SaveGameError("incompatible", `Migration from schema ${from} failed; the original save is unchanged.`); }
    }
    data.schemaVersion = this.definition.schemaVersion;
    return data;
  }

  private info(body: SaveBody, recovered = false): SaveGameInfo {
    return { projectId: body.projectId, profile: body.profile, slot: body.slot, definitionId: body.definitionId, schemaVersion: body.schemaVersion, sequence: body.sequence, createdAt: body.createdAt, recovered, status: "ok" };
  }

  private async readSlot(address: Address): Promise<SlotRead> {
    const candidates: Candidate[] = [];
    let damaged = false;
    // Sequential reads keep adapters simple and retain a single transaction lock.
    for (let index = 0; index < generationNames.length; index++) {
      const text = await this.options.storage.read(`${address.prefix}/${generationNames[index]}`);
      if (text === null) continue;
      try {
        const body = await this.decode(text);
        if (body.projectId !== this.projectId || body.profile !== address.profile || body.slot !== address.slot) throw new SaveGameError("corrupt", "Save location does not match its contents.");
        candidates.push({ index, text, body });
      } catch (error) {
        if (!(error instanceof SaveGameError) || error.code !== "corrupt") throw error;
        damaged = true;
      }
    }
    if (!candidates.length && damaged) throw new SaveGameError("corrupt", "No valid save generation remains. Delete the damaged slot explicitly, or import a known good save into another slot.");
    candidates.sort((a, b) => b.body.sequence - a.body.sequence);
    return { latest: candidates[0] ?? null, recovered: damaged && candidates.length > 0 };
  }

  private async decode(text: string): Promise<SaveBody> {
    if (typeof text !== "string" || text.length > MAX_SAVE_BYTES * 2 || new TextEncoder().encode(text).byteLength > MAX_SAVE_BYTES * 2) throw new SaveGameError("corrupt", "Save file exceeds the supported size.");
    let outer: unknown;
    try { outer = JSON.parse(text); } catch { throw new SaveGameError("corrupt", "Save file is not valid JSON."); }
    if (!isSaveGameRecord(outer) || !Number.isSafeInteger(outer.formatVersion)) throw new SaveGameError("corrupt", "Save envelope is invalid.");
    if (outer.formatVersion !== FORMAT_VERSION) throw new SaveGameError("incompatible", "This save uses an unsupported format version.");
    if (typeof outer.payload !== "string" || typeof outer.checksum !== "string" || !/^[a-f0-9]{64}$/.test(outer.checksum)) throw new SaveGameError("corrupt", "Save checksum is missing or invalid.");
    let hash: string;
    try { hash = await checksum(outer.payload); }
    catch (error) { if (error instanceof SaveGameError && error.code === "invalid") throw new SaveGameError("corrupt", error.message); throw error; }
    if (hash !== outer.checksum) throw new SaveGameError("corrupt", "Save checksum does not match its contents.");
    let parsed: unknown;
    try { parsed = cloneSaveGameValue(JSON.parse(outer.payload)); }
    catch { throw new SaveGameError("corrupt", "Save payload is invalid."); }
    if (!isSaveGameRecord(parsed) || parsed.formatVersion !== FORMAT_VERSION || typeof parsed.projectId !== "string" || typeof parsed.definitionId !== "string" || typeof parsed.profile !== "string" || typeof parsed.slot !== "string" || !Number.isSafeInteger(parsed.schemaVersion) || (parsed.schemaVersion as number) < 1 || !Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 1 || typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || !isSaveGameRecord(parsed.fields) || !Object.hasOwn(parsed, "state")) throw new SaveGameError("corrupt", "Save metadata or gameplay fields are invalid.");
    return parsed as unknown as SaveBody;
  }

  private async archive(address: Address, body: SaveBody, text: string): Promise<void> {
    const originalHash = (JSON.parse(text) as { checksum: string }).checksum;
    const key = `${address.prefix}/original-v${body.schemaVersion}-${body.sequence}-${originalHash}.save`;
    const archived = await this.options.storage.read(key);
    if (archived === null) {
      await this.options.storage.write(key, text);
      if (await this.options.storage.read(key) !== text) throw new SaveGameError("corrupt", "The migration original could not be preserved. The previous save is unchanged.");
    } else if (archived !== text) {
      throw new SaveGameError("corrupt", "The archived migration original is damaged. The previous save is unchanged.");
    }
  }

  private async commit(address: Address, captured: Pick<SaveGameMigrationData, "fields" | "state">, existing: SlotRead): Promise<SaveGameInfo> {
    const last = existing.latest;
    if (last && last.body.schemaVersion < this.definition.schemaVersion) await this.archive(address, last.body, last.text);
    const sequence = (last?.body.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new SaveGameError("incompatible", "The save sequence is exhausted.");
    const body: SaveBody = { formatVersion: FORMAT_VERSION, projectId: this.projectId, definitionId: this.definition.id, schemaVersion: this.definition.schemaVersion, profile: address.profile, slot: address.slot, sequence, createdAt: new Date().toISOString(), fields: captured.fields, state: captured.state };
    validateSaveGameValue(body);
    // Release the simulation boundary before encoding. Worker hosts already encode
    // off the rendering thread; other hosts may inject an asynchronous codec.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const payload = this.options.encode ? await this.options.encode(body as unknown as SaveGameValue) : JSON.stringify(body);
    const text = JSON.stringify({ formatVersion: FORMAT_VERSION, checksum: await checksum(payload), payload });
    // Never replace the newest valid generation, including when its sibling was torn.
    const index = last?.index === 0 ? 1 : 0;
    const key = `${address.prefix}/${generationNames[index]}`;
    await this.options.storage.write(key, text);
    if (await this.options.storage.read(key) !== text) throw new SaveGameError("corrupt", "The stored generation failed verification. The previous save is preserved.");
    return this.info(body, existing.recovered);
  }

  private async removePrefix(prefix: string): Promise<void> {
    for (const key of await this.options.storage.list(prefix)) {
      if (key.startsWith(prefix)) await this.options.storage.remove(key);
    }
  }
}
