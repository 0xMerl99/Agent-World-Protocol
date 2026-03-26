/**
 * TickEngine — Runs the world simulation loop.
 * 
 * Processes actions, updates state, and broadcasts observations
 * at a configurable tick rate.
 */

class TickEngine {
  constructor(worldState, options = {}) {
    this.world = worldState;
    this.tickRate = options.tickRate || 1000; // ms between ticks
    this.running = false;
    this.timer = null;
    this.listeners = new Map(); // event type -> Set of callbacks
    this.tickCount = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[TickEngine] Started at ${this.tickRate}ms interval`);
    this._scheduleTick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log(`[TickEngine] Stopped after ${this.tickCount} ticks`);
  }

  _scheduleTick() {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      const startTime = Date.now();

      // Process the tick
      const tickResult = this.world.processTick();
      this.tickCount++;

      const processingTime = Date.now() - startTime;

      // Emit tick result to listeners
      this._emit('tick', {
        ...tickResult,
        processingTime,
      });

      // Emit individual events
      for (const event of tickResult.events) {
        this._emit('event', event);
      }

      // Log periodically
      if (this.tickCount % 60 === 0) {
        const stats = this.world.getWorldStats();
        console.log(`[TickEngine] Tick ${stats.tick} | ${stats.agents} agents | ${stats.zones} zones | ${stats.buildings} buildings | ${processingTime}ms`);
      }

      // Schedule next tick, accounting for processing time
      const delay = Math.max(0, this.tickRate - processingTime);
      this._scheduleTick();
    }, this.tickRate);
  }

  // Event system
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  _emit(event, data) {
    if (this.listeners.has(event)) {
      for (const callback of this.listeners.get(event)) {
        try {
          callback(data);
        } catch (err) {
          console.error(`[TickEngine] Listener error on '${event}':`, err.message);
        }
      }
    }
  }
}

module.exports = { TickEngine };
