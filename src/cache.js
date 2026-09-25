/**
 * Small in-memory LRU cache with TTL. Re-analysing the same document with the
 * same options returns instantly and avoids a second Gemini call.
 */
import { createHash } from 'node:crypto';

export class LruCache {
  constructor({ maxEntries = 100, ttlMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  get size() {
    return this.map.size;
  }
}

/** Stable hash of any JSON-serialisable value. */
export function hashKey(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(typeof part === 'string' ? part : JSON.stringify(part)).update('\u0000');
  return hash.digest('hex');
}
