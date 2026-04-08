/**
 * BotManager — Server-side autonomous agent runner.
 *
 * Spawns bot agents that live inside the server process (no WebSocket needed).
 * Each bot has stackable behavior modules: Explorer, Trader, Fighter, Social, Builder.
 * Users pick which behaviors to enable — they all run on a single agent.
 *
 * Ownership is tied to a Solana wallet address. Users connect their wallet
 * in the browser, sign a challenge to prove ownership, and manage their bots
 * via that wallet address. Works across devices — no localStorage needed.
 */

class BotManager {
  constructor(worldState) {
    this.world = worldState;
    this.bots = new Map(); // agentId -> bot config
    this.MAX_BOTS_PER_WALLET = 5;
    this.MAX_MET_AGENTS = 200;     // cap memory sets to prevent unbounded growth
    this.MAX_RATED_AGENTS = 200;
    this.MAX_EXPLORED_ZONES = 100;
  }

  /**
   * Launch a bot owned by a wallet address.
   * @param {string} ownerWallet - Solana wallet address (owner)
   * @param {string} name - Agent display name
   * @param {string[]} behaviors - Behavior modules to enable
   * @returns {{ agentId, name, behaviors, ownerWallet }}
   */
  launch(ownerWallet, name, behaviors = ['explorer']) {
    if (!ownerWallet || typeof ownerWallet !== 'string' || ownerWallet.length < 30 || ownerWallet.length > 44) {
      throw new Error('Valid wallet address required (30-44 characters)');
    }

    // Enforce per-wallet bot limit
    const existingCount = this.list(ownerWallet).filter(b => b.running).length;
    if (existingCount >= this.MAX_BOTS_PER_WALLET) {
      throw new Error(`Maximum ${this.MAX_BOTS_PER_WALLET} active bots per wallet`);
    }

    const validBehaviors = ['explorer', 'trader', 'fighter', 'social', 'builder'];
    const selected = behaviors.filter(b => validBehaviors.includes(b));
    if (selected.length === 0) selected.push('explorer');

    // Sanitize name
    const safeName = (typeof name === 'string' ? name.replace(/[<>&"']/g, '').trim().slice(0, 30) : '') || 'Bot';

    // All bots share the owner's wallet — one wallet funds all your agents
    const agent = this.world.addAgent({ wallet: ownerWallet, name: safeName });

    const bot = {
      agentId: agent.id,
      ownerWallet,
      name: agent.name,
      wallet: ownerWallet,
      behaviors: selected,
      running: true,
      launchedAt: Date.now(),
      state: this._freshState(),
    };

    this.bots.set(agent.id, bot);
    return { agentId: agent.id, name: agent.name, behaviors: selected, ownerWallet };
  }

  _freshState() {
    return {
      direction: { x: 1, y: 0 },
      ticksSinceMove: 0,
      exploredZones: new Set(),
      metAgents: new Set(),
      ratedAgents: new Set(),
      greetings: [
        'Hey there!',
        'Greetings, fellow agent.',
        'What brings you to this zone?',
        'Nice to meet you.',
        'Anyone trading around here?',
      ],
      hasHome: false,
      hasUpgraded: false,
      lastGatherTick: 0,
      lastCraftTick: 0,
      lastSellTick: 0,
      lastAttackTick: 0,
      defending: false,
    };
  }

  /**
   * Run one decision cycle for all active bots. Called each tick.
   */
  tick() {
    for (const [agentId, bot] of this.bots) {
      if (!bot.running) continue;
      const agent = this.world.getAgent(agentId);
      if (!agent || agent.status === 'dead') continue;

      try {
        const obs = this.world.getObservation(agentId);
        if (!obs) continue;
        this._decide(bot, agent, obs);
      } catch (err) {
        console.error(`[BotManager] Error for bot ${agentId}:`, err.message);
      }
    }
  }

  /**
   * Stop a running bot. Requires matching wallet.
   */
  stop(agentId, ownerWallet) {
    const bot = this.bots.get(agentId);
    if (!bot) return false;
    // Always require wallet match — never skip validation
    if (!ownerWallet || bot.ownerWallet !== ownerWallet) return false;
    bot.running = false;
    return true;
  }

  /**
   * Resume a stopped bot. Requires matching wallet.
   */
  resume(agentId, ownerWallet) {
    const bot = this.bots.get(agentId);
    if (!bot) return false;
    // Always require wallet match — never skip validation
    if (!ownerWallet || bot.ownerWallet !== ownerWallet) return false;
    bot.running = true;
    return true;
  }

  /**
   * List bots owned by a specific wallet, or all bots if no wallet given.
   */
  list(ownerWallet) {
    const result = [];
    for (const [agentId, bot] of this.bots) {
      if (ownerWallet && bot.ownerWallet !== ownerWallet) continue;
      const agent = this.world.getAgent(agentId);
      result.push({
        agentId,
        ownerWallet: bot.ownerWallet,
        name: bot.name,
        behaviors: bot.behaviors,
        running: bot.running,
        launchedAt: bot.launchedAt,
        position: agent ? { x: agent.x, y: agent.y } : null,
        level: agent ? agent.level : 0,
        hp: agent ? agent.combat.hp : 0,
      });
    }
    return result;
  }

  // ==================== PERSISTENCE ====================

  /**
   * Serialize bot configs for DB storage.
   */
  serialize() {
    const data = [];
    for (const [, bot] of this.bots) {
      data.push({
        agentId: bot.agentId,
        ownerWallet: bot.ownerWallet,
        name: bot.name,
        wallet: bot.wallet,
        behaviors: bot.behaviors,
        running: bot.running,
        launchedAt: bot.launchedAt,
      });
    }
    return JSON.stringify(data);
  }

  /**
   * Restore bots from DB data. Only restores bots whose agents still exist.
   */
  restore(json) {
    try {
      const data = JSON.parse(json);
      if (!Array.isArray(data)) return 0;
      let count = 0;
      for (const entry of data) {
        const agent = this.world.getAgent(entry.agentId);
        if (!agent) continue;

        this.bots.set(entry.agentId, {
          agentId: entry.agentId,
          ownerWallet: entry.ownerWallet,
          name: entry.name,
          wallet: entry.wallet,
          behaviors: entry.behaviors,
          running: entry.running,
          launchedAt: entry.launchedAt,
          state: this._freshState(),
        });
        count++;
      }
      if (count > 0) console.log(`[BotManager] Restored ${count} bots`);
      return count;
    } catch (e) {
      console.error('[BotManager] Restore error:', e.message);
      return 0;
    }
  }

  // ==================== DECISION ENGINE ====================

  _decide(bot, agent, obs) {
    const { behaviors } = bot;
    const tick = obs.tick || this.world.tick;

    if (behaviors.includes('fighter')) {
      if (this._fighterAct(bot, agent, obs, tick)) return;
    }
    if (behaviors.includes('social')) {
      if (this._socialAct(bot, agent, obs, tick)) return;
    }
    if (behaviors.includes('trader')) {
      if (this._traderAct(bot, agent, obs, tick)) return;
    }
    if (behaviors.includes('builder')) {
      if (this._builderAct(bot, agent, obs, tick)) return;
    }
    if (behaviors.includes('explorer')) {
      this._explorerAct(bot, agent, obs, tick);
    }
  }

  _fighterAct(bot, agent, obs, tick) {
    const { state } = bot;
    const { nearbyAgents, self } = obs;

    if (self.combat && self.combat.hp < self.combat.maxHp * 0.4) {
      if (!state.defending) {
        this.world.queueAction(agent.id, { type: 'defend' });
        state.defending = true;
        return true;
      }
      return false;
    }
    state.defending = false;

    const enemies = nearbyAgents.filter(a =>
      a.id !== agent.id && a.combat && a.combat.hp > 0 && a.guildId !== agent.guildId
    );
    if (enemies.length > 0 && tick - state.lastAttackTick >= 3) {
      this.world.queueAction(agent.id, { type: 'attack', targetId: enemies[0].id });
      state.lastAttackTick = tick;
      return true;
    }

    const tile = this.world.tiles.get(`${self.x},${self.y}`);
    if (tile && tile.owner && tile.owner !== agent.id && tick % 20 === 0) {
      this.world.queueAction(agent.id, { type: 'contest_territory', x: self.x, y: self.y });
      return true;
    }
    return false;
  }

  _socialAct(bot, agent, obs, tick) {
    const { state } = bot;
    const { nearbyAgents } = obs;

    const newAgents = nearbyAgents.filter(a => a.id !== agent.id && !state.metAgents.has(a.id));
    if (newAgents.length > 0) {
      const target = newAgents[0];
      if (state.metAgents.size < this.MAX_MET_AGENTS) state.metAgents.add(target.id);
      const greeting = state.greetings[Math.floor(Math.random() * state.greetings.length)];
      this.world.queueAction(agent.id, { type: 'speak', message: `${greeting} (to ${target.name})` });
      return true;
    }

    const ratable = nearbyAgents.filter(a =>
      a.id !== agent.id && state.metAgents.has(a.id) && !state.ratedAgents.has(a.id)
    );
    if (ratable.length > 0 && Math.random() < 0.2) {
      const target = ratable[0];
      this.world.queueAction(agent.id, { type: 'rate_agent', targetAgentId: target.id, score: 3 + Math.floor(Math.random() * 3), comment: 'Good neighbor' });
      if (state.ratedAgents.size < this.MAX_RATED_AGENTS) state.ratedAgents.add(target.id);
      return true;
    }
    return false;
  }

  _traderAct(bot, agent, obs, tick) {
    const { state } = bot;
    const inv = agent.metadata?.inventory || {};

    if (tick - state.lastGatherTick >= 4) {
      this.world.queueAction(agent.id, { type: 'gather' });
      state.lastGatherTick = tick;
      return true;
    }
    if (tick - state.lastCraftTick >= 20 && (inv.wood || 0) >= 3 && (inv.stone || 0) >= 2) {
      this.world.queueAction(agent.id, { type: 'craft', recipe: 'wooden_tools' });
      state.lastCraftTick = tick;
      return true;
    }
    if (tick - state.lastSellTick >= 30) {
      const surplus = Object.entries(inv).find(([, v]) => typeof v === 'number' && v > 10);
      if (surplus) {
        this.world.queueAction(agent.id, { type: 'market_sell', item: surplus[0], quantity: 5, pricePerUnit: 0.001 });
        state.lastSellTick = tick;
        return true;
      }
    }
    return false;
  }

  _builderAct(bot, agent, obs, tick) {
    const { state } = bot;
    const { self, nearbyBuildings } = obs;

    if (!state.hasHome && tick > 10) {
      if (!nearbyBuildings.some(b => b.x === self.x && b.y === self.y)) {
        this.world.queueAction(agent.id, { type: 'build', buildingType: 'home', x: self.x, y: self.y });
        state.hasHome = true;
        return true;
      }
    }
    if (state.hasHome && !state.hasUpgraded && tick > 50) {
      const own = nearbyBuildings.find(b => b.ownerId === agent.id);
      if (own) {
        this.world.queueAction(agent.id, { type: 'upgrade', buildingId: own.id });
        state.hasUpgraded = true;
        return true;
      }
    }
    const tile = this.world.tiles.get(`${self.x},${self.y}`);
    if (tile && !tile.owner && tick % 15 === 0) {
      this.world.queueAction(agent.id, { type: 'claim', x: self.x, y: self.y });
      return true;
    }
    return false;
  }

  _explorerAct(bot, agent, obs) {
    const { state } = bot;
    const { self } = obs;

    state.ticksSinceMove++;
    if (state.ticksSinceMove < 2) return false;

    if (Math.random() < 0.3) {
      const dirs = [
        { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
        { x: 1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 },
      ];
      state.direction = dirs[Math.floor(Math.random() * dirs.length)];
    }

    this.world.queueAction(agent.id, { type: 'move', x: self.x + state.direction.x, y: self.y + state.direction.y });
    state.ticksSinceMove = 0;
    return true;
  }
}

module.exports = { BotManager };
