import { promises as fs } from 'node:fs';
import type { StateStore } from './types.js';

const MAX_MEMORY_STATE_SIZE = 10_000;

export class FileStateStore implements StateStore {
  private seen = new Set<string>();
  readonly persistsOnWrite = false;
  readonly backendName = 'file';

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed)) {
        this.seen = new Set(parsed);
      }
    } catch {
      this.seen = new Set();
    }
  }

  async save(): Promise<void> {
    const dir = this.parentDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(Array.from(this.seen), null, 2),
      'utf8'
    );
  }

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

  private parentDir(): string {
    const idx = this.filePath.lastIndexOf('/');
    if (idx <= 0) return '.';
    return this.filePath.slice(0, idx);
  }

  private evictIfNeeded(): void {
    if (this.seen.size <= MAX_MEMORY_STATE_SIZE) return;
    const excess = this.seen.size - MAX_MEMORY_STATE_SIZE;
    let removed = 0;
    for (const key of this.seen) {
      if (removed >= excess) break;
      this.seen.delete(key);
      removed += 1;
    }
  }
}
