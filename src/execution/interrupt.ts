import { rollbackSession } from '../git/client.js';
import { uiStream } from '../ui/stream.js';

let handlerRegistered = false;
let interrupted = false;
let signalHandler: (() => void) | null = null;

export function registerInterruptHandler(sessionId: string, workdir: string): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  signalHandler = () => {
    if (!interrupted) {
      interrupted = true;
      uiStream.push({ type: 'interrupt_requested' });

      // Wait for user's choice (c/s/r) via the TUI
      uiStream.waitForInterruptResolution().then(async action => {
        if (action === 'rollback') {
          try {
            const filesRestored = await rollbackSession(workdir, sessionId);
            uiStream.push({ type: 'rollback_complete', filesRestored });
          } catch (err) {
            uiStream.push({ type: 'error', message: `Rollback failed: ${(err as Error).message}` });
          }
          process.exit(0);
        } else if (action === 'stop') {
          uiStream.push({ type: 'session_cancelled', summary: 'Stopped by user. Recovery plan retained.' });
          process.exit(130);
        } else {
          // continue — reset flag so next Ctrl+C works again
          interrupted = false;
        }
      }).catch(() => { /* ignore */ });
    } else {
      // Leave the working tree in place for inspection and recovery.
      console.error('\nForce exit. Changes and recovery plan retained.');
      process.exit(130);
    }
  };
  process.on('SIGINT', signalHandler);
}

export function resetInterruptHandler(): void {
  if (signalHandler) process.off('SIGINT', signalHandler);
  signalHandler = null;
  handlerRegistered = false;
  interrupted = false;
}
