import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";

/** Resources produced by one visual generation, recorded before binding overrides. */
export class VisualBundle {
  private retired = false;
  private readonly cancellations = new Set<() => void>();
  private readonly renderUsers = new Set<{ dispose(): void; isDisposed?(): boolean }>();
  private readonly textures = new Set<BaseTexture>();
  private readonly releases = new Set<() => void>();

  ownRenderUser<T extends { dispose(): void }>(user: T): T {
    this.renderUsers.add(user);
    return user;
  }

  ownTexture<T extends BaseTexture>(texture: T): T {
    this.textures.add(texture);
    return texture;
  }

  cancelWith(callback: () => void): void { this.cancellations.add(callback); }
  releaseWith(callback: () => void): void { this.releases.add(callback); }

  dispose(): void {
    if (this.retired) return;
    this.retired = true;
    // Continue retiring the generation if one native disposal fails.
    const failures: unknown[] = [];
    const run = (callback: () => void) => {
      try { callback(); } catch (error) { failures.push(error); }
    };
    for (const cancel of this.cancellations) run(cancel);
    for (const user of this.renderUsers) run(() => { if (!user.isDisposed?.()) user.dispose(); });
    for (const texture of this.textures) run(() => texture.dispose());
    for (const release of this.releases) run(release);
    this.cancellations.clear();
    this.renderUsers.clear();
    this.textures.clear();
    this.releases.clear();
    if (failures.length) throw new AggregateError(failures, "Visual retirement failed");
  }
}
