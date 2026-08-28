export class AutopilotCancelledError extends Error {
  constructor() {
    super('autopilot execution cancelled');
    this.name = 'AutopilotCancelledError';
  }
}

export class AutopilotExecutionControl {
  private readonly abortController = new AbortController();
  private paused = false;
  private pauseWaiters: Array<() => void> = [];

  get signal() {
    return this.abortController.signal;
  }

  get isPaused() {
    return this.paused;
  }

  pause() {
    if (this.signal.aborted) return;
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const waiters = this.pauseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  cancel() {
    if (this.signal.aborted) return;
    this.abortController.abort();
    this.resume();
  }

  async checkpoint() {
    if (this.signal.aborted) throw new AutopilotCancelledError();
    while (this.paused) {
      await new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
      if (this.signal.aborted) throw new AutopilotCancelledError();
    }
  }
}

export async function controlledDelay(control: AutopilotExecutionControl, milliseconds: number) {
  const end = performance.now() + Math.max(0, milliseconds);
  while (performance.now() < end) {
    await control.checkpoint();
    const remaining = end - performance.now();
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(80, Math.max(0, remaining))));
  }
  await control.checkpoint();
}
