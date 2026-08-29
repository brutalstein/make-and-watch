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

  async run(lease, operation) {
    if (!lease || typeof lease.kind !== 'string' || typeof operation !== 'function') {
      throw new Error('GPU scheduler requires a lease descriptor and operation');
    }
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const predecessor = this.tail;
    this.tail = turn;
    this.waiting += 1;
    await predecessor.catch(() => undefined);
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
