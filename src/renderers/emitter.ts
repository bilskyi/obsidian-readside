export class Emitter<T> {
  private listeners = new Set<(v: T) => void>();

  on(listener: (v: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** How many listeners are subscribed (lets a producer skip work nobody would receive). */
  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }

  /** Each listener is isolated: a throwing listener is logged and does not stop the others. */
  emit(value: T): void {
    this.listeners.forEach((l) => {
      try {
        l(value);
      } catch (err) {
        console.error('Emitter: listener threw', err);
      }
    });
  }
}
