export interface CachedClip {
  dispose(): void;
}
interface Entry<T> {
  key: string;
  promise: Promise<T>;
  value?: T;
  used: number;
}

/** 每只猫独立使用；当前片段 + 最近两段，加载中的片段额外受保护。 */
export class ClipCache<T extends CachedClip> {
  private entries = new Map<string, Entry<T>>();
  private clock = 0;
  private current: string | undefined;
  private wanted: string | undefined;
  private disposed = false;

  constructor(private readonly load: (key: string) => Promise<T>) {}

  request(key: string): Promise<T> {
    this.wanted = key;
    const existing = this.entries.get(key);
    if (existing) {
      existing.used = ++this.clock;
      return existing.promise;
    }
    const entry: Entry<T> = {
      key,
      used: ++this.clock,
      promise: Promise.resolve().then(() => this.load(key)),
    };
    this.entries.set(key, entry);
    entry.promise = entry.promise.then(
      (value) => {
        if (this.disposed) {
          value.dispose();
          return value;
        }
        entry.value = value;
        this.trim();
        return value;
      },
      (error: unknown) => {
        this.entries.delete(key);
        throw error;
      },
    );
    return entry.promise;
  }

  activate(key: string): void {
    const entry = this.entries.get(key);
    if (!entry?.value) return;
    this.current = key;
    entry.used = ++this.clock;
    this.trim();
  }

  private trim(): void {
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.value && entry.key !== this.current && entry.key !== this.wanted)
      .sort((a, b) => b.used - a.used);
    // wanted 在加载时不占最近两段；加载完成时将成为当前，旧 current 也受保护。
    const ready = [...this.entries.values()].filter((entry) => entry.value).length;
    let count = ready;
    for (const entry of candidates.reverse()) {
      if (count <= 3) break;
      entry.value?.dispose();
      this.entries.delete(entry.key);
      count--;
    }
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.value?.dispose();
    this.entries.clear();
  }
}
