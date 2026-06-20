import { rollbackSession } from '../git/client.js';
import { uiStream } from '../ui/stream.js';

let handlerRegistered = false;
let interrupted = false;

export function registerInterruptHandler(sessionId: string, workdir: string): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  process.on('SIGINT', () => {
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
          uiStream.ensureDone('Stopped by user.');
          process.exit(0);
        } else {
          // continue — reset flag so next Ctrl+C works again
          interrupted = false;
        }
      }).catch(() => { /* ignore */ });
    } else {
      // Second Ctrl+C before user responded: force rollback and exit
      console.error('\nForce exit — rolling back…');
      rollbackSession(workdir, sessionId)
        .then(() => process.exit(130))
        .catch(() => process.exit(130));
    }
  });
}

export function resetInterruptHandler(): void {
  handlerRegistered = false;
  interrupted = false;
}
