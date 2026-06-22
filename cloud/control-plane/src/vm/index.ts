import { DockerDriver } from './docker';
import { FirecrackerDriver } from './firecracker';
import type { VMDriver } from './types';

let cached: VMDriver | null = null;

export function getVMDriver(): VMDriver {
  if (cached) return cached;
  cached =
    process.env.VM_DRIVER === 'firecracker'
      ? new FirecrackerDriver()
      : new DockerDriver();
  return cached;
}

export function setVMDriver(driver: VMDriver | null): void {
  cached = driver;
}

export { DockerDriver } from './docker';
export { FirecrackerDriver } from './firecracker';
export type { VMDriver, VMHandle, VMStatus } from './types';
