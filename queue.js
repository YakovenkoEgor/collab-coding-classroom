// A tiny concurrency limiter.
//
// Sandbox runs are the most expensive thing the server does: each one starts
// two containers. Without a cap, thirty students pressing Run at the same
// moment would ask the host for thirty JVMs at once. This lets a fixed number
// through and makes the rest wait their turn.

class QueueFullError extends Error {}

class Limiter {
  constructor(slots, maxQueue = 60) {
    this.slots = Math.max(1, slots);
    this.maxQueue = maxQueue;
    this.active = 0;
    this.waiting = []; // resolvers of tasks queued for a free slot
  }

  get queued() {
    return this.waiting.length;
  }

  // Waits for a slot and returns the function that gives it back.
  acquire() {
    if (this.active < this.slots) {
      this.active++;
      return Promise.resolve(() => this._release());
    }
    if (this.waiting.length >= this.maxQueue) {
      return Promise.reject(
        new QueueFullError(
          "The server is busy running other students' code. Try again in a moment."
        )
      );
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve(() => this._release());
      });
    });
  }

  _release() {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }

  // Runs fn in a slot, always giving the slot back - including on failure.
  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  stats() {
    return { slots: this.slots, active: this.active, queued: this.waiting.length };
  }
}

module.exports = { Limiter, QueueFullError };
