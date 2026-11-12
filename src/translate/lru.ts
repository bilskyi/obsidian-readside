// A small LRU map: ⌥-hover word cache (500 per pair) and the loaded-model set (see residency.ts).

export interface LruOptions<K, V> {
  /** Called when an entry leaves the cache (evicted, deleted or cleared), not when replaced. */
  onEvict?: (key: K, value: V) => void;
}

export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  private readonly max: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(max: number, opts: LruOptions<K, V> = {}) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`Lru max must be a positive integer, got ${max}`);
    this.max = max;
    this.onEvict = opts.onEvict;
  }

  get size(): number {
    return this.map.size;
  }

  /** The value, marking it most recently used. */
  get(k: K): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k) as V;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  /** The value without touching recency. */
  peek(k: K): V | undefined {
    return this.map.get(k);
  }

  has(k: K): boolean {
    return this.map.has(k);
  }

  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const [oldK, oldV] = this.map.entries().next().value as [K, V];
      this.map.delete(oldK);
      this.onEvict?.(oldK, oldV);
    }
  }

  delete(k: K): boolean {
    if (!this.map.has(k)) return false;
    const v = this.map.get(k) as V;
    this.map.delete(k);
    this.onEvict?.(k, v);
    return true;
  }

  clear(): void {
    const entries = [...this.map];
    this.map.clear();
    for (const [k, v] of entries) this.onEvict?.(k, v);
  }

  /** Keys from least to most recently used. */
  keys(): K[] {
    return [...this.map.keys()];
  }
}
