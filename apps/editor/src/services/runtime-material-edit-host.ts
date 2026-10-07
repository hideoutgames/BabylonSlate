import type { CommandMessage, ControlMessage, RuntimeMaterialEditPreparation } from "@babylonslate/bridge";

type MaterialCommit = Extract<CommandMessage, { type: "assignMaterial" | "setMaterialParameter" }>;
type Response = Extract<ControlMessage, { type: "runtimeMaterialEditPrepared" | "runtimeMaterialEditApplied" }>;
type Stage = { request: RuntimeMaterialEditPreparation; prepared: boolean; applied: boolean };
type Ports = {
  sessionGeneration: number; mode: "play" | "simulate" | "preview";
  prepare(request: RuntimeMaterialEditPreparation): Promise<void>;
  commit(command: MaterialCommit): { success: boolean; reason?: string };
  release(editToken: string): void;
  respond(message: Response): void;
};

/** Owns only explicitly requested live material edits; no polling or eager assets. */
export class RuntimeMaterialEditHost {
  private readonly ports: Ports;
  private readonly stages = new Map<string, Stage>();
  private stopped = false;
  constructor(ports: Ports) { this.ports = ports; }

  /** True means the ordinary render command path must not apply this command. */
  receive(command: CommandMessage): boolean {
    if (command.type === "prepareRuntimeMaterialEdit") {
      if (this.stopped || command.sessionGeneration !== this.ports.sessionGeneration) return true;
      if (this.ports.mode !== "simulate" || this.stages.size >= 8 || this.stages.has(command.editToken)) {
        this.respond("runtimeMaterialEditPrepared", command, false, "Material edit preparation is unavailable or its pending limit was reached.");
        return true;
      }
      const stage = { request: command, prepared: false, applied: false };
      this.stages.set(command.editToken, stage);
      void Promise.resolve().then(() => {
        if (this.stages.get(command.editToken) !== stage) return;
        return this.ports.prepare(command);
      }).then(() => {
        if (this.stopped || this.stages.get(command.editToken) !== stage) return;
        stage.prepared = true;
        this.respond("runtimeMaterialEditPrepared", command, true);
      }, reason => {
        if (this.stopped || this.stages.get(command.editToken) !== stage) return;
        this.remove(stage);
        this.respond("runtimeMaterialEditPrepared", command, false, message(reason));
      });
      return true;
    }
    if (command.type === "releaseRuntimeMaterialPreparation") {
      if (command.sessionGeneration === this.ports.sessionGeneration) {
        const stage = this.stages.get(command.editToken);
        if (stage) this.remove(stage);
      }
      return true;
    }
    if ((command.type === "assignMaterial" || command.type === "setMaterialParameter") && command.preparedEditToken !== undefined) {
      // Unknown or retired tokens never fall back to direct native mutation.
      const stage = this.stages.get(command.preparedEditToken);
      if (!stage || this.stopped) return true;
      if (stage.applied) return true;
      let result: { success: boolean; reason?: string };
      try {
        result = stage.prepared ? this.ports.commit(command) : { success: false, reason: "Material preparation has not completed." };
      } catch (reason) { result = { success: false, reason: message(reason) }; }
      if (!result.success) this.remove(stage);
      else stage.applied = true;
      this.respond("runtimeMaterialEditApplied", stage.request, result.success, result.reason);
      return true;
    }
    return false;
  }

  invalidate(reason = "The scene changed while its material was preparing."): void {
    for (const stage of [...this.stages.values()]) {
      this.remove(stage);
      this.respond(stage.prepared ? "runtimeMaterialEditApplied" : "runtimeMaterialEditPrepared", stage.request, false, reason);
    }
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const stage of [...this.stages.values()]) this.remove(stage);
  }

  private remove(stage: Stage): void {
    if (this.stages.get(stage.request.editToken) !== stage) return;
    this.stages.delete(stage.request.editToken);
    this.ports.release(stage.request.editToken);
  }

  private respond(type: Response["type"], request: RuntimeMaterialEditPreparation, success: boolean, reason?: string): void {
    if (this.stopped) return;
    this.ports.respond({ type, sessionGeneration: request.sessionGeneration, requestId: request.requestId,
      editToken: request.editToken, success, ...(reason ? { reason } : {}) });
  }
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
