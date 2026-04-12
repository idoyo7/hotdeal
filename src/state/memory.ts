import type { StateStore } from './types.js';

const MAX_MEMORY_STATE_SIZE = 10_000;

export class MemoryStateStore implements StateStore {
  private seen = new Set<string>();
  readonly persistsOnWrite = false;
  readonly backendName = 'memory';

  async load(): Promise<void> {
    this.seen = new Set();
  }

  async save(): Promise<void> {}

  async has(id: string): Promise<boolean> {
    return this.seen.has(id);
  }

  async add(id: string): Promise<void> {
    this.seen.add(id);
  }

  async claim(id: string): Promise<boolean> {
    if (this.seen.has(id)) {
      return false;
    }
    this.seen.add(id);
    this.evictIfNeeded();
    return true;
  }

  async unclaim(id: string): Promise<void> {
    this.seen.delete(id);
  }

  async close(): Promise<void> {}

  private evictIfNeeded(): void {
    if (this.seen.size <= MAX_MEMORY_STATE_SIZE) {
      return;
    }
    const excess = this.seen.size - MAX_MEMORY_STATE_SIZE;
    let removed = 0;
    for (const key of this.seen) {
      if (removed >= excess) break;
      this.seen.delete(key);
      removed += 1;
    }
  }
}
