import type { CommandMessage } from "./channels";

/**
 * Hands each command of a worker `commands` message to `dispatch` in order, as
 * if it had arrived alone: a throwing command does not skip the rest (the first
 * failure is rethrown after the batch, later ones surface as their own uncaught
 * errors), and a host that stopped mid-batch receives nothing more.
 */
export function dispatchCommandBatch(
  commands: readonly CommandMessage[],
  dispatch: (command: CommandMessage) => void,
  stopped: () => boolean = () => false,
): void {
  let failed = false;
  let failure: unknown;
  for (const command of commands) {
    if (stopped()) break;
    try {
      dispatch(command);
    } catch (error) {
      if (failed) queueMicrotask(() => { throw error; });
      else { failed = true; failure = error; }
    }
  }
  if (failed) throw failure;
}
