import { uiStream } from '../ui/stream.js';

let signalHandler: (() => void) | null = null;

/** Cancellation unwinds the orchestrator so results and recovery data are saved. */
export function registerInterruptHandler(): void {
  if (signalHandler) return;
  signalHandler = () => {
    if (uiStream.signal.aborted) process.exit(130);
    uiStream.cancelSession('Stopped by SIGINT. Changes remain in the session workspace.');
  };
  process.on('SIGINT', signalHandler);
}
export function resetInterruptHandler(): void {
  if (signalHandler) process.off('SIGINT', signalHandler);
  signalHandler = null;
}
