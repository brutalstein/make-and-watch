function waitForTurn(predecessor, signal) {
  if (!signal) return predecessor.catch(() => undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) return aborted();
    void predecessor.catch(() => undefined).then(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      resolve();
    });
  });
}

export class GpuExclusiveScheduler {
  constructor() {
    this.tail = Promise.resolve();
    this.active = null;
    this.waiting = 0;
  }

  status() {
    return {
      active: this.active ? { ...this.active } : null,
      waiting: this.waiting,
    };
  }

  async run(lease, operation, { signal } = {}) {
    if (!lease || typeof lease.kind !== 'string' || typeof operation !== 'function') {
      throw new Error('GPU scheduler requires a lease descriptor and operation');
    }
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const predecessor = this.tail;
    this.tail = turn;
    this.waiting += 1;
    try {
      signal?.throwIfAborted();
      await waitForTurn(predecessor, signal);
      signal?.throwIfAborted();
    } catch (error) {
      this.waiting = Math.max(0, this.waiting - 1);
      void predecessor.catch(() => undefined).then(release);
      throw error;
    }
    this.waiting = Math.max(0, this.waiting - 1);
    this.active = {
      kind: lease.kind,
      id: String(lease.id ?? ''),
      since: new Date().toISOString(),
    };
    try {
      return await operation();
    } finally {
      this.active = null;
      release();
    }
  }
}
