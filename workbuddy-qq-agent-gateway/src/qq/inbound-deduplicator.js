export class InboundDeduplicator {
  constructor({ ttlMs = 10 * 60 * 1000, clock = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.entries = new Map();
  }

  async run(key, receive) {
    const now = this.clock();
    for (const [id, entry] of this.entries) {
      if (entry.completedAt != null && now - entry.completedAt > this.ttlMs) this.entries.delete(id);
    }
    let entry = this.entries.get(key);
    if (entry?.completedAt != null) return { status: "ok", duplicate: true };
    if (entry?.promise) return entry.promise;
    if (!entry) {
      entry = { operation: receive, accepted: false, completedAt: null, promise: null };
      this.entries.set(key, entry);
    }
    const accept = (resume) => {
      // After durable intake, retries resume follow-up work without reappending.
      entry.accepted = true;
      entry.operation = resume;
      return resume();
    };
    const operation = Promise.resolve().then(() => entry.operation(accept));
    entry.promise = operation;
    try {
      const result = await operation;
      entry.completedAt = this.clock();
      entry.operation = null;
      return result;
    } catch (error) {
      if (!entry.accepted) this.entries.delete(key);
      else console.warn(`QQ inbound follow-up failed for ${key}; durable receipt retained for retry: ${error.message}`);
      throw error;
    } finally {
      entry.promise = null;
    }
  }
}
