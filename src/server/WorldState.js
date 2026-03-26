/**
 * WorldState — The authoritative state of the entire world.
 * 
 * Manages zones, agents, buildings, and the spatial grid.
 * All mutations go through this class to maintain consistency.
 */

const { v4: uuidv4 } = require('uuid');

// Default world config
const DEFAULT_CONFIG = {
  PERCEPTION_RADIUS: 10,
  ZONE_SIZE: 32,           // tiles per zone side
  TILE_SIZE: 64,           // pixels per tile (for rendering)
  MAX_ACTIONS_PER_TICK: 3, // max actions an agent can submit per tick
  SPEAK_RADIUS: 8,         // how far speech carries (in tiles)
  WHISPER_RADIUS: 2,       // must be within 2 tiles to whisper
  TRADE_RADIUS: 3,         // must be within 3 tiles to trade
  BUILD_RADIUS: 1,         // must be on or adjacent to build
  INITIAL_ZONES: ['village_center'], // zones that exist at world start
};

// Zone biome types
const BIOME = {
  VILLAGE: 'village',
  AUTUMN_TOWN: 'autumn_town',
  FARMLAND: 'farmland',
  INDUSTRIAL: 'industrial',
  WILDERNESS: 'wilderness',
  HIGHLANDS: 'highlands',
  WINTER_TOWN: 'winter_town',
};

// Building types
const BUILDING_TYPE = {
  HOME: 'home',
  SHOP: 'shop',
  VAULT: 'vault',
  LAB: 'lab',
  HEADQUARTERS: 'headquarters',
};

// Building costs (in lamports — 1 SOL = 1e9 lamports)
const BUILDING_COST = {
  [BUILDING_TYPE.HOME]: 0.1e9,
  [BUILDING_TYPE.SHOP]: 0.25e9,
  [BUILDING_TYPE.VAULT]: 0.5e9,
  [BUILDING_TYPE.LAB]: 0.5e9,
  [BUILDING_TYPE.HEADQUARTERS]: 1e9,
};

// Land claim cost (in lamports)
const LAND_CLAIM_COST = 0.01e9; // 0.01 SOL per tile

// Building upgrade costs (in lamports)
const UPGRADE_COST = {
  2: 0.2e9,  // upgrade to level 2
  3: 0.5e9,  // upgrade to level 3
};

class WorldState {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tick = 0;
    this.startedAt = Date.now();

    // Core state
    this.agents = new Map();       // agentId -> AgentState
    this.zones = new Map();        // zoneId -> ZoneState
    this.buildings = new Map();    // buildingId -> BuildingState
    this.tiles = new Map();        // "x,y" -> TileState

    // Economy — in-world ledger (tracks SOL balances for each agent)
    // In production this maps to real on-chain wallets via bridges
    // For now, agents deposit SOL and the ledger tracks spending
    this.ledger = new Map();       // agentId -> { balance: lamports, deposits: [], withdrawals: [], spending: [] }
    this.protocolRevenue = 0;      // total lamports collected as protocol fees
    this.transactionLog = [];      // all economic transactions

    // Pending trades — waiting for acceptance
    this.pendingTrades = new Map(); // tradeId -> TradeProposal

    // Action queue for current tick
    this.actionQueue = [];

    // Event log for current tick (broadcast to agents)
    this.tickEvents = [];

    // Initialize the starting zone
    this._initStartingZones();
  }

  // ==================== ZONE MANAGEMENT ====================

  _initStartingZones() {
    this.createZone({
      id: 'village_center',
      name: 'Village Center',
      biome: BIOME.VILLAGE,
      originX: 0,
      originY: 0,
    });
  }

  createZone({ id, name, biome, originX, originY }) {
    const zoneId = id || uuidv4();
    const zone = {
      id: zoneId,
      name: name || `Zone ${zoneId.slice(0, 6)}`,
      biome: biome || BIOME.WILDERNESS,
      originX,
      originY,
      width: this.config.ZONE_SIZE,
      height: this.config.ZONE_SIZE,
      createdAt: Date.now(),
      agentCount: 0,
    };

    this.zones.set(zoneId, zone);

    // Initialize tiles for this zone
    for (let x = originX; x < originX + zone.width; x++) {
      for (let y = originY; y < originY + zone.height; y++) {
        const key = `${x},${y}`;
        if (!this.tiles.has(key)) {
          this.tiles.set(key, {
            x, y,
            zoneId,
            terrain: this._getDefaultTerrain(biome),
            buildingId: null,
            owner: null,        // agentId who claimed this tile
            claimedAt: null,    // tick when claimed
            agentIds: [],
          });
        }
      }
    }

    return zone;
  }

  _getDefaultTerrain(biome) {
    const terrainMap = {
      [BIOME.VILLAGE]: 'grass',
      [BIOME.AUTUMN_TOWN]: 'cobblestone',
      [BIOME.FARMLAND]: 'soil',
      [BIOME.INDUSTRIAL]: 'stone',
      [BIOME.WILDERNESS]: 'grass',
      [BIOME.HIGHLANDS]: 'rock',
      [BIOME.WINTER_TOWN]: 'snow',
    };
    return terrainMap[biome] || 'grass';
  }

  getZoneAt(x, y) {
    const tile = this.tiles.get(`${x},${y}`);
    if (tile) return this.zones.get(tile.zoneId);
    return null;
  }

  // Check if coordinates are near the edge of known world, trigger expansion
  checkAndExpandWorld(x, y) {
    const buffer = 5; // tiles from edge to trigger expansion
    let expanded = false;

    for (const [, zone] of this.zones) {
      const edgeRight = zone.originX + zone.width;
      const edgeBottom = zone.originY + zone.height;

      // Check if agent is near any edge of existing zones
      if (x >= edgeRight - buffer && !this.getZoneAt(edgeRight, y)) {
        this.createZone({
          biome: this._pickFrontierBiome(),
          originX: edgeRight,
          originY: zone.originY,
        });
        expanded = true;
      }
      if (x <= zone.originX + buffer && !this.getZoneAt(zone.originX - 1, y)) {
        this.createZone({
          biome: this._pickFrontierBiome(),
          originX: zone.originX - this.config.ZONE_SIZE,
          originY: zone.originY,
        });
        expanded = true;
      }
      if (y >= edgeBottom - buffer && !this.getZoneAt(x, edgeBottom)) {
        this.createZone({
          biome: this._pickFrontierBiome(),
          originX: zone.originX,
          originY: edgeBottom,
        });
        expanded = true;
      }
      if (y <= zone.originY + buffer && !this.getZoneAt(x, zone.originY - 1)) {
        this.createZone({
          biome: this._pickFrontierBiome(),
          originX: zone.originX,
          originY: zone.originY - this.config.ZONE_SIZE,
        });
        expanded = true;
      }
    }

    return expanded;
  }

  _pickFrontierBiome() {
    const biomes = Object.values(BIOME);
    return biomes[Math.floor(Math.random() * biomes.length)];
  }

  // ==================== AGENT MANAGEMENT ====================

  addAgent({ id, wallet, name, metadata = {} }) {
    const agentId = id || uuidv4();

    // Spawn in village center
    const spawnX = Math.floor(this.config.ZONE_SIZE / 2) + Math.floor(Math.random() * 5 - 2);
    const spawnY = Math.floor(this.config.ZONE_SIZE / 2) + Math.floor(Math.random() * 5 - 2);

    const agent = {
      id: agentId,
      wallet: wallet || null,
      name: name || `Agent-${agentId.slice(0, 6)}`,
      x: spawnX,
      y: spawnY,
      connectedAt: Date.now(),
      lastActionTick: 0,
      actionsThisTick: 0,
      status: 'active',       // active, idle, paused
      metadata,

      // Procedural appearance — deterministic from wallet/id
      appearance: this._generateAppearance(wallet || agentId),

      // Reputation
      reputation: {
        tradesCompleted: 0,
        tradesFailed: 0,
        buildingsOwned: 0,
        ticksActive: 0,
        totalVolumeTraded: 0,
      },

      // Operator controls (guardrails)
      controls: {
        maxSpendPerTick: null,   // lamports, null = unlimited
        zoneBlacklist: [],
        agentBlacklist: [],
        allowedActions: null,    // null = all, or array of action types
        paused: false,
      },
    };

    this.agents.set(agentId, agent);
    this._initLedger(agentId);

    // Add to tile
    const tileKey = `${spawnX},${spawnY}`;
    const tile = this.tiles.get(tileKey);
    if (tile) {
      tile.agentIds.push(agentId);
      const zone = this.zones.get(tile.zoneId);
      if (zone) zone.agentCount++;
    }

    // Emit event
    this.tickEvents.push({
      type: 'agent_joined',
      agentId,
      name: agent.name,
      x: spawnX,
      y: spawnY,
      tick: this.tick,
    });

    return agent;
  }

  removeAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    // Remove from tile
    const tileKey = `${agent.x},${agent.y}`;
    const tile = this.tiles.get(tileKey);
    if (tile) {
      tile.agentIds = tile.agentIds.filter(id => id !== agentId);
      const zone = this.zones.get(tile.zoneId);
      if (zone) zone.agentCount--;
    }

    this.agents.delete(agentId);

    this.tickEvents.push({
      type: 'agent_left',
      agentId,
      tick: this.tick,
    });

    return true;
  }

  getAgent(agentId) {
    return this.agents.get(agentId) || null;
  }

  // ==================== OBSERVATION (What an agent can see) ====================

  getObservation(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const radius = this.config.PERCEPTION_RADIUS;

    // Nearby agents
    const nearbyAgents = [];
    for (const [id, other] of this.agents) {
      if (id === agentId) continue;
      const dist = Math.abs(other.x - agent.x) + Math.abs(other.y - agent.y); // Manhattan distance
      if (dist <= radius) {
        nearbyAgents.push({
          id: other.id,
          name: other.name,
          x: other.x,
          y: other.y,
          status: other.status,
          appearance: other.appearance,
          distance: dist,
        });
      }
    }

    // Nearby buildings
    const nearbyBuildings = [];
    for (const [, building] of this.buildings) {
      const dist = Math.abs(building.x - agent.x) + Math.abs(building.y - agent.y);
      if (dist <= radius) {
        nearbyBuildings.push({
          id: building.id,
          type: building.type,
          name: building.name,
          owner: building.owner,
          x: building.x,
          y: building.y,
          isPublic: building.isPublic,
          appearance: building.appearance,
          distance: dist,
        });
      }
    }

    // Current zone info
    const zone = this.getZoneAt(agent.x, agent.y);

    return {
      tick: this.tick,
      self: {
        id: agent.id,
        name: agent.name,
        x: agent.x,
        y: agent.y,
        wallet: agent.wallet,
        status: agent.status,
        reputation: { ...agent.reputation },
      },
      zone: zone ? {
        id: zone.id,
        name: zone.name,
        biome: zone.biome,
        agentCount: zone.agentCount,
      } : null,
      nearbyAgents,
      nearbyBuildings,
      recentEvents: this.tickEvents.filter(e => {
        // Whispers — only visible to sender and receiver
        if (e.type === 'whisper') {
          return e.fromAgentId === agentId || e.toAgentId === agentId;
        }
        // Trade proposals — visible to both parties
        if (e.type === 'trade_proposed') {
          return e.fromAgentId === agentId || e.toAgentId === agentId;
        }
        // Spatial events — within perception radius
        if (e.x !== undefined && e.y !== undefined) {
          const dist = Math.abs(e.x - agent.x) + Math.abs(e.y - agent.y);
          return dist <= radius;
        }
        // Personal events (agent_joined, etc.)
        return e.agentId === agentId;
      }),
    };
  }

  // ==================== ACTION PROCESSING ====================

  queueAction(agentId, action) {
    const agent = this.agents.get(agentId);
    if (!agent) return { success: false, error: 'Agent not found' };
    if (agent.controls.paused) return { success: false, error: 'Agent is paused by operator' };
    if (agent.actionsThisTick >= this.config.MAX_ACTIONS_PER_TICK) {
      return { success: false, error: 'Max actions per tick exceeded' };
    }

    // Check if action type is allowed by operator controls
    if (agent.controls.allowedActions && !agent.controls.allowedActions.includes(action.type)) {
      return { success: false, error: `Action type '${action.type}' not allowed by operator` };
    }

    this.actionQueue.push({
      id: uuidv4(),
      agentId,
      ...action,
      queuedAt: this.tick,
    });

    return { success: true, actionId: this.actionQueue[this.actionQueue.length - 1].id };
  }

  processTick() {
    this.tick++;
    this.tickEvents = [];

    // Process all queued actions
    const results = [];
    for (const action of this.actionQueue) {
      const result = this._executeAction(action);
      results.push(result);
    }

    // Update agent stats
    for (const [, agent] of this.agents) {
      agent.actionsThisTick = 0;
      if (agent.status === 'active') {
        agent.reputation.ticksActive++;
      }
    }

    // Clean up expired trades
    for (const [tradeId, trade] of this.pendingTrades) {
      if (this.tick > trade.expiresAt) {
        trade.status = 'expired';
        this.pendingTrades.delete(tradeId);
        this.tickEvents.push({
          type: 'trade_expired',
          tradeId,
          fromAgentId: trade.fromAgentId,
          toAgentId: trade.toAgentId,
          tick: this.tick,
        });
      }
    }

    // Clear action queue
    this.actionQueue = [];

    return {
      tick: this.tick,
      results,
      events: [...this.tickEvents],
      agentCount: this.agents.size,
      zoneCount: this.zones.size,
    };
  }

  _executeAction(action) {
    const agent = this.agents.get(action.agentId);
    if (!agent) return { actionId: action.id, success: false, error: 'Agent not found' };

    switch (action.type) {
      case 'move':
        return this._actionMove(agent, action);
      case 'speak':
        return this._actionSpeak(agent, action);
      case 'whisper':
        return this._actionWhisper(agent, action);
      case 'trade':
        return this._actionTrade(agent, action);
      case 'accept_trade':
        return this._actionAcceptTrade(agent, action);
      case 'reject_trade':
        return this._actionRejectTrade(agent, action);
      case 'claim':
        return this._actionClaim(agent, action);
      case 'build':
        return this._actionBuild(agent, action);
      case 'upgrade':
        return this._actionUpgrade(agent, action);
      case 'sell_land':
        return this._actionSellLand(agent, action);
      case 'enter':
        return this._actionEnter(agent, action);
      case 'inspect':
        return this._actionInspect(agent, action);
      case 'deposit':
        return this._actionDeposit(agent, action);
      case 'balance':
        return this._actionBalance(agent, action);
      case 'bridge':
        return this._actionBridge(agent, action);
      default:
        return { actionId: action.id, success: false, error: `Unknown action type: ${action.type}` };
    }
  }

  // --- MOVE ---
  _actionMove(agent, action) {
    const { x, y } = action;
    if (x === undefined || y === undefined) {
      return { actionId: action.id, success: false, error: 'Missing x or y' };
    }

    // Validate move distance (max 1 tile per tick in any direction)
    const dx = Math.abs(x - agent.x);
    const dy = Math.abs(y - agent.y);
    if (dx > 1 || dy > 1) {
      return { actionId: action.id, success: false, error: 'Can only move 1 tile per tick' };
    }

    // Check zone blacklist
    const targetZone = this.getZoneAt(x, y);
    if (targetZone && agent.controls.zoneBlacklist.includes(targetZone.id)) {
      return { actionId: action.id, success: false, error: 'Zone is blacklisted by operator' };
    }

    // Check if tile exists (expand world if needed)
    if (!this.tiles.has(`${x},${y}`)) {
      this.checkAndExpandWorld(x, y);
    }

    // Remove from old tile
    const oldTileKey = `${agent.x},${agent.y}`;
    const oldTile = this.tiles.get(oldTileKey);
    if (oldTile) {
      oldTile.agentIds = oldTile.agentIds.filter(id => id !== agent.id);
      const oldZone = this.zones.get(oldTile.zoneId);
      if (oldZone) oldZone.agentCount--;
    }

    // Move agent
    agent.x = x;
    agent.y = y;

    // Add to new tile
    const newTileKey = `${x},${y}`;
    const newTile = this.tiles.get(newTileKey);
    if (newTile) {
      newTile.agentIds.push(agent.id);
      const newZone = this.zones.get(newTile.zoneId);
      if (newZone) newZone.agentCount++;
    }

    // Check if world needs expansion
    this.checkAndExpandWorld(x, y);

    this.tickEvents.push({
      type: 'agent_moved',
      agentId: agent.id,
      x, y,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { x, y } };
  }

  // --- SPEAK ---
  _actionSpeak(agent, action) {
    const { message } = action;
    if (!message || typeof message !== 'string') {
      return { actionId: action.id, success: false, error: 'Missing or invalid message' };
    }

    const truncated = message.slice(0, 500); // cap message length

    this.tickEvents.push({
      type: 'agent_spoke',
      agentId: agent.id,
      name: agent.name,
      message: truncated,
      x: agent.x,
      y: agent.y,
      radius: this.config.SPEAK_RADIUS,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { delivered: true } };
  }

  // --- WHISPER ---
  _actionWhisper(agent, action) {
    const { targetAgentId, message } = action;
    if (!targetAgentId || !message) {
      return { actionId: action.id, success: false, error: 'Missing targetAgentId or message' };
    }

    const target = this.agents.get(targetAgentId);
    if (!target) {
      return { actionId: action.id, success: false, error: 'Target agent not found' };
    }

    // Check agent blacklist
    if (agent.controls.agentBlacklist.includes(targetAgentId)) {
      return { actionId: action.id, success: false, error: 'Target agent is blacklisted' };
    }

    // Check distance
    const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
    if (dist > this.config.WHISPER_RADIUS) {
      return { actionId: action.id, success: false, error: `Target too far (${dist} tiles, max ${this.config.WHISPER_RADIUS})` };
    }

    const truncated = message.slice(0, 500);

    // Whisper events only visible to sender and receiver
    this.tickEvents.push({
      type: 'whisper',
      fromAgentId: agent.id,
      fromName: agent.name,
      toAgentId: targetAgentId,
      message: truncated,
      tick: this.tick,
      // No x,y — whispers are private, filtered by agentId in getObservation
    });

    return { actionId: action.id, success: true, data: { delivered: true } };
  }

  // --- TRADE ---
  // Trade flow: propose → accept/reject → execute
  // Offer/request format: { sol: lamports } or { token: mint, amount: number }
  // For MVP, only SOL trades are supported via the ledger
  _actionTrade(agent, action) {
    const { targetAgentId, offer, request } = action;
    if (!targetAgentId || !offer || !request) {
      return { actionId: action.id, success: false, error: 'Missing trade parameters. Need: targetAgentId, offer: { sol }, request: { sol }' };
    }

    const target = this.agents.get(targetAgentId);
    if (!target) {
      return { actionId: action.id, success: false, error: 'Target agent not found' };
    }

    // Check agent blacklist
    if (agent.controls.agentBlacklist.includes(targetAgentId)) {
      return { actionId: action.id, success: false, error: 'Target is blacklisted' };
    }

    // Check distance
    const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
    if (dist > this.config.TRADE_RADIUS) {
      return { actionId: action.id, success: false, error: `Target too far for trade (${dist} tiles, max ${this.config.TRADE_RADIUS})` };
    }

    // Validate offer — proposer must have enough balance
    if (offer.sol && offer.sol > 0) {
      const balance = this.getBalance(agent.id);
      if (balance.balance < offer.sol) {
        return { actionId: action.id, success: false, error: `Cannot afford offer: have ${balance.balance} lamports, offering ${offer.sol}` };
      }
    }

    // Create pending trade
    const tradeId = uuidv4();
    const trade = {
      id: tradeId,
      fromAgentId: agent.id,
      fromName: agent.name,
      toAgentId: targetAgentId,
      toName: target.name,
      offer, // what proposer gives
      request, // what proposer wants
      status: 'pending',
      proposedAt: this.tick,
      expiresAt: this.tick + 30, // expires after 30 ticks (~30 seconds)
    };

    this.pendingTrades.set(tradeId, trade);

    // Notify both parties
    this.tickEvents.push({
      type: 'trade_proposed',
      tradeId,
      fromAgentId: agent.id,
      fromName: agent.name,
      toAgentId: targetAgentId,
      offer,
      request,
      expiresAt: trade.expiresAt,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { tradeId, status: 'pending', expiresAt: trade.expiresAt } };
  }

  // --- ACCEPT TRADE ---
  _actionAcceptTrade(agent, action) {
    const { tradeId } = action;
    if (!tradeId) {
      return { actionId: action.id, success: false, error: 'Missing tradeId' };
    }

    const trade = this.pendingTrades.get(tradeId);
    if (!trade) {
      return { actionId: action.id, success: false, error: 'Trade not found or already completed' };
    }

    // Only the target can accept
    if (trade.toAgentId !== agent.id) {
      return { actionId: action.id, success: false, error: 'Only the trade recipient can accept' };
    }

    // Check expiry
    if (this.tick > trade.expiresAt) {
      this.pendingTrades.delete(tradeId);
      return { actionId: action.id, success: false, error: 'Trade expired' };
    }

    if (trade.status !== 'pending') {
      return { actionId: action.id, success: false, error: `Trade already ${trade.status}` };
    }

    // Execute the trade — transfer SOL between agents
    // Step 1: Verify both parties can afford their side
    const proposer = trade.fromAgentId;
    const accepter = trade.toAgentId;

    if (trade.offer.sol && trade.offer.sol > 0) {
      const proposerBal = this.getBalance(proposer);
      if (proposerBal.balance < trade.offer.sol) {
        trade.status = 'failed';
        this.pendingTrades.delete(tradeId);
        return { actionId: action.id, success: false, error: 'Proposer can no longer afford offer' };
      }
    }

    if (trade.request.sol && trade.request.sol > 0) {
      const accepterBal = this.getBalance(accepter);
      if (accepterBal.balance < trade.request.sol) {
        return { actionId: action.id, success: false, error: `Cannot afford requested amount: need ${trade.request.sol} lamports` };
      }
    }

    // Step 2: Execute transfers with 0.1% protocol fee on each side
    const feeBps = 10; // 0.1%
    let proposerPaid = 0;
    let accepterPaid = 0;
    let protocolFees = 0;

    // Proposer sends offer
    if (trade.offer.sol && trade.offer.sol > 0) {
      const fee = Math.floor(trade.offer.sol * feeBps / 10000);
      const net = trade.offer.sol - fee;
      this.spend(proposer, trade.offer.sol, `trade ${tradeId}: sent to ${accepter}`);
      this.protocolRevenue -= trade.offer.sol; // undo protocol revenue from spend()
      this.earn(accepter, net, `trade ${tradeId}: received from ${proposer}`);
      this.protocolRevenue += fee;
      protocolFees += fee;
      proposerPaid = trade.offer.sol;
    }

    // Accepter sends request (what proposer requested)
    if (trade.request.sol && trade.request.sol > 0) {
      const fee = Math.floor(trade.request.sol * feeBps / 10000);
      const net = trade.request.sol - fee;
      this.spend(accepter, trade.request.sol, `trade ${tradeId}: sent to ${proposer}`);
      this.protocolRevenue -= trade.request.sol;
      this.earn(proposer, net, `trade ${tradeId}: received from ${accepter}`);
      this.protocolRevenue += fee;
      protocolFees += fee;
      accepterPaid = trade.request.sol;
    }

    // Update trade status
    trade.status = 'completed';
    trade.completedAt = this.tick;
    this.pendingTrades.delete(tradeId);

    // Update reputations
    const proposerAgent = this.agents.get(proposer);
    const accepterAgent = this.agents.get(accepter);
    if (proposerAgent) {
      proposerAgent.reputation.tradesCompleted++;
      proposerAgent.reputation.totalVolumeTraded += proposerPaid;
    }
    if (accepterAgent) {
      accepterAgent.reputation.tradesCompleted++;
      accepterAgent.reputation.totalVolumeTraded += accepterPaid;
    }

    this.tickEvents.push({
      type: 'trade_completed',
      tradeId,
      fromAgentId: proposer,
      toAgentId: accepter,
      offer: trade.offer,
      request: trade.request,
      protocolFees,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        tradeId,
        status: 'completed',
        proposerPaid,
        accepterPaid,
        protocolFees,
        proposerBalance: this.getBalance(proposer).balance,
        accepterBalance: this.getBalance(accepter).balance,
      },
    };
  }

  // --- REJECT TRADE ---
  _actionRejectTrade(agent, action) {
    const { tradeId } = action;
    if (!tradeId) {
      return { actionId: action.id, success: false, error: 'Missing tradeId' };
    }

    const trade = this.pendingTrades.get(tradeId);
    if (!trade) {
      return { actionId: action.id, success: false, error: 'Trade not found' };
    }

    // Either party can reject
    if (trade.fromAgentId !== agent.id && trade.toAgentId !== agent.id) {
      return { actionId: action.id, success: false, error: 'Not your trade' };
    }

    trade.status = 'rejected';
    this.pendingTrades.delete(tradeId);

    this.tickEvents.push({
      type: 'trade_rejected',
      tradeId,
      rejectedBy: agent.id,
      fromAgentId: trade.fromAgentId,
      toAgentId: trade.toAgentId,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { tradeId, status: 'rejected' } };
  }

  // --- BUILD ---
  _actionBuild(agent, action) {
    const { buildingType, x, y } = action;
    const bx = x !== undefined ? x : agent.x;
    const by = y !== undefined ? y : agent.y;

    if (!buildingType || !BUILDING_COST[buildingType]) {
      return { actionId: action.id, success: false, error: `Invalid building type: ${buildingType}. Valid: ${Object.keys(BUILDING_COST).join(', ')}` };
    }

    // Check distance
    const dist = Math.abs(bx - agent.x) + Math.abs(by - agent.y);
    if (dist > this.config.BUILD_RADIUS) {
      return { actionId: action.id, success: false, error: 'Too far to build' };
    }

    // Check tile
    const tileKey = `${bx},${by}`;
    const tile = this.tiles.get(tileKey);
    if (!tile) {
      return { actionId: action.id, success: false, error: 'Invalid tile' };
    }
    if (tile.buildingId) {
      return { actionId: action.id, success: false, error: 'Tile already has a building' };
    }

    // Must own the land — auto-claim if unclaimed
    if (tile.owner && tile.owner !== agent.id) {
      return { actionId: action.id, success: false, error: `Land owned by another agent. Claim it first or buy from owner.` };
    }

    // Auto-claim unclaimed land
    let claimCost = 0;
    if (!tile.owner) {
      claimCost = LAND_CLAIM_COST;
      const claimPayment = this.spend(agent.id, claimCost, `auto-claim land (${bx},${by}) for building`);
      if (!claimPayment.success) {
        return { actionId: action.id, success: false, error: `Cannot afford land claim (${claimCost / 1e9} SOL): ${claimPayment.error}` };
      }
      tile.owner = agent.id;
      tile.claimedAt = this.tick;
    }

    // Pay building cost
    const buildCost = BUILDING_COST[buildingType];
    const buildPayment = this.spend(agent.id, buildCost, `build ${buildingType} at (${bx},${by})`);
    if (!buildPayment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford building (${buildCost / 1e9} SOL): ${buildPayment.error}` };
    }

    const totalCost = claimCost + buildCost;

    // Create building
    const buildingId = uuidv4();
    const building = {
      id: buildingId,
      type: buildingType,
      name: `${agent.name}'s ${buildingType}`,
      owner: agent.id,
      ownerWallet: agent.wallet,
      x: bx,
      y: by,
      zoneId: tile.zoneId,
      isPublic: buildingType !== BUILDING_TYPE.HOME,
      createdAt: Date.now(),
      createdAtTick: this.tick,
      appearance: this._generateBuildingAppearance(agent.wallet || agent.id, buildingType),
    };

    this.buildings.set(buildingId, building);
    tile.buildingId = buildingId;
    agent.reputation.buildingsOwned++;

    this.tickEvents.push({
      type: 'building_created',
      agentId: agent.id,
      buildingId,
      buildingType,
      appearance: building.appearance,
      cost: totalCost,
      x: bx,
      y: by,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { buildingId, type: buildingType, x: bx, y: by } };
  }

  // --- ENTER ---
  _actionEnter(agent, action) {
    const { buildingId } = action;
    if (!buildingId) {
      return { actionId: action.id, success: false, error: 'Missing buildingId' };
    }

    const building = this.buildings.get(buildingId);
    if (!building) {
      return { actionId: action.id, success: false, error: 'Building not found' };
    }

    // Check distance
    const dist = Math.abs(building.x - agent.x) + Math.abs(building.y - agent.y);
    if (dist > 1) {
      return { actionId: action.id, success: false, error: 'Too far from building' };
    }

    // Check permission
    if (!building.isPublic && building.owner !== agent.id) {
      return { actionId: action.id, success: false, error: 'Building is private' };
    }

    this.tickEvents.push({
      type: 'agent_entered_building',
      agentId: agent.id,
      buildingId,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { buildingId, type: building.type } };
  }

  // --- INSPECT ---
  _actionInspect(agent, action) {
    const { targetAgentId } = action;
    if (!targetAgentId) {
      return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    }

    const target = this.agents.get(targetAgentId);
    if (!target) {
      return { actionId: action.id, success: false, error: 'Target agent not found' };
    }

    // Check distance
    const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
    if (dist > this.config.PERCEPTION_RADIUS) {
      return { actionId: action.id, success: false, error: 'Target out of perception range' };
    }

    return {
      actionId: action.id,
      success: true,
      data: {
        id: target.id,
        name: target.name,
        status: target.status,
        reputation: { ...target.reputation },
        buildingsOwned: [...this.buildings.values()].filter(b => b.owner === targetAgentId).map(b => ({
          id: b.id,
          type: b.type,
          x: b.x,
          y: b.y,
        })),
        connectedAt: target.connectedAt,
      }
    };
  }

  // --- DEPOSIT ---
  _actionDeposit(agent, action) {
    const { amount, amountSOL } = action;
    const lamports = amount || (amountSOL ? Math.floor(amountSOL * 1e9) : 0);

    if (lamports <= 0) {
      return { actionId: action.id, success: false, error: 'Missing or invalid amount' };
    }

    // In production: verify on-chain transfer to world wallet
    // For now: direct credit to ledger (demo/testing mode)
    const result = this.deposit(agent.id, lamports, 'direct deposit');

    this.tickEvents.push({
      type: 'deposit',
      agentId: agent.id,
      amount: lamports,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        deposited: lamports,
        depositedSOL: lamports / 1e9,
        balance: result.balance,
        balanceSOL: result.balance / 1e9,
      },
    };
  }

  // --- BALANCE ---
  _actionBalance(agent, action) {
    const balanceInfo = this.getBalance(agent.id);
    const ownedTiles = [...this.tiles.values()].filter(t => t.owner === agent.id).length;
    const ownedBuildings = [...this.buildings.values()].filter(b => b.owner === agent.id);

    return {
      actionId: action.id,
      success: true,
      data: {
        ...balanceInfo,
        ownedTiles,
        ownedBuildings: ownedBuildings.length,
        buildingValues: ownedBuildings.map(b => ({
          id: b.id,
          type: b.type,
          level: b.appearance.level,
          estimatedValue: BUILDING_COST[b.type] + (b.appearance.level > 1 ? UPGRADE_COST[b.appearance.level] : 0),
        })),
      },
    };
  }

  // --- BRIDGE (placeholder — external bridges handle actual execution) ---
  _actionBridge(agent, action) {
    const { bridge, bridgeAction, params } = action;
    if (!bridge || !bridgeAction) {
      return { actionId: action.id, success: false, error: 'Missing bridge or bridgeAction' };
    }

    // Bridge actions are handled by the BridgeManager, not WorldState
    // This just validates and queues the intent
    this.tickEvents.push({
      type: 'bridge_request',
      agentId: agent.id,
      bridge,
      bridgeAction,
      params,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { status: 'queued', bridge, bridgeAction } };
  }

  // ==================== ECONOMY / LEDGER ====================

  /**
   * Initialize ledger for an agent. Called on agent creation.
   */
  _initLedger(agentId) {
    if (!this.ledger.has(agentId)) {
      this.ledger.set(agentId, {
        balance: 0,
        totalDeposited: 0,
        totalSpent: 0,
        totalEarned: 0,
        history: [],
      });
    }
  }

  /**
   * Deposit SOL into an agent's world balance.
   * In production, this would be triggered by an on-chain transfer to the world wallet.
   */
  deposit(agentId, amountLamports, source = 'deposit') {
    this._initLedger(agentId);
    const account = this.ledger.get(agentId);
    account.balance += amountLamports;
    account.totalDeposited += amountLamports;
    account.history.push({
      type: 'deposit',
      amount: amountLamports,
      source,
      tick: this.tick,
      timestamp: Date.now(),
    });

    this._logTransaction(agentId, 'deposit', amountLamports, source);
    return { success: true, balance: account.balance };
  }

  /**
   * Spend SOL from an agent's balance. Returns false if insufficient funds.
   */
  spend(agentId, amountLamports, reason) {
    this._initLedger(agentId);
    const account = this.ledger.get(agentId);

    if (account.balance < amountLamports) {
      return { success: false, error: `Insufficient balance: have ${account.balance}, need ${amountLamports}`, balance: account.balance };
    }

    account.balance -= amountLamports;
    account.totalSpent += amountLamports;
    account.history.push({
      type: 'spend',
      amount: amountLamports,
      reason,
      tick: this.tick,
      timestamp: Date.now(),
    });

    // Protocol gets the revenue
    this.protocolRevenue += amountLamports;

    this._logTransaction(agentId, 'spend', amountLamports, reason);
    return { success: true, balance: account.balance };
  }

  /**
   * Earn SOL — added to agent's balance (from rent, trades, etc.)
   */
  earn(agentId, amountLamports, source) {
    this._initLedger(agentId);
    const account = this.ledger.get(agentId);
    account.balance += amountLamports;
    account.totalEarned += amountLamports;
    account.history.push({
      type: 'earn',
      amount: amountLamports,
      source,
      tick: this.tick,
      timestamp: Date.now(),
    });

    this._logTransaction(agentId, 'earn', amountLamports, source);
    return { success: true, balance: account.balance };
  }

  /**
   * Transfer SOL between two agents.
   */
  transfer(fromAgentId, toAgentId, amountLamports, reason) {
    const fromAccount = this.ledger.get(fromAgentId);
    if (!fromAccount || fromAccount.balance < amountLamports) {
      return { success: false, error: 'Insufficient balance' };
    }

    const spendResult = this.spend(fromAgentId, amountLamports, `transfer to ${toAgentId}: ${reason}`);
    if (!spendResult.success) return spendResult;

    // Transfer goes to the other agent, not protocol revenue
    // So undo the protocol revenue addition from spend() and give to recipient
    this.protocolRevenue -= amountLamports;
    this.earn(toAgentId, amountLamports, `transfer from ${fromAgentId}: ${reason}`);

    return { success: true, fromBalance: this.ledger.get(fromAgentId).balance, toBalance: this.ledger.get(toAgentId).balance };
  }

  /**
   * Get an agent's balance and financial summary.
   */
  getBalance(agentId) {
    this._initLedger(agentId);
    const account = this.ledger.get(agentId);
    return {
      balance: account.balance,
      balanceSOL: account.balance / 1e9,
      totalDeposited: account.totalDeposited,
      totalSpent: account.totalSpent,
      totalEarned: account.totalEarned,
      pnl: account.totalEarned - account.totalSpent,
      historyCount: account.history.length,
    };
  }

  /**
   * Get an agent's full transaction history.
   */
  getTransactionHistory(agentId, limit = 50) {
    this._initLedger(agentId);
    return this.ledger.get(agentId).history.slice(-limit);
  }

  /**
   * Get protocol revenue summary.
   */
  getProtocolRevenue() {
    return {
      totalLamports: this.protocolRevenue,
      totalSOL: this.protocolRevenue / 1e9,
      transactionCount: this.transactionLog.length,
    };
  }

  _logTransaction(agentId, type, amount, reason) {
    this.transactionLog.push({
      agentId,
      type,
      amount,
      reason,
      tick: this.tick,
      timestamp: Date.now(),
    });
    // Keep manageable
    if (this.transactionLog.length > 10000) {
      this.transactionLog = this.transactionLog.slice(-5000);
    }
  }

  // ==================== LAND CLAIM ACTION ====================

  _actionClaim(agent, action) {
    const { x, y } = action;
    const cx = x !== undefined ? x : agent.x;
    const cy = y !== undefined ? y : agent.y;

    // Must be close
    const dist = Math.abs(cx - agent.x) + Math.abs(cy - agent.y);
    if (dist > 2) {
      return { actionId: action.id, success: false, error: 'Too far to claim (max 2 tiles)' };
    }

    const tileKey = `${cx},${cy}`;
    const tile = this.tiles.get(tileKey);
    if (!tile) {
      return { actionId: action.id, success: false, error: 'Invalid tile' };
    }
    if (tile.owner) {
      return { actionId: action.id, success: false, error: `Tile already claimed by ${tile.owner}` };
    }

    // Pay claim cost
    const cost = LAND_CLAIM_COST;
    const payment = this.spend(agent.id, cost, `land claim (${cx},${cy})`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford land claim: ${payment.error}` };
    }

    // Claim the tile
    tile.owner = agent.id;
    tile.claimedAt = this.tick;

    this.tickEvents.push({
      type: 'land_claimed',
      agentId: agent.id,
      x: cx,
      y: cy,
      cost,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { x: cx, y: cy, cost, costSOL: cost / 1e9, balance: payment.balance },
    };
  }

  _actionUpgrade(agent, action) {
    const { buildingId } = action;
    if (!buildingId) {
      return { actionId: action.id, success: false, error: 'Missing buildingId' };
    }

    const building = this.buildings.get(buildingId);
    if (!building) {
      return { actionId: action.id, success: false, error: 'Building not found' };
    }
    if (building.owner !== agent.id) {
      return { actionId: action.id, success: false, error: 'Not your building' };
    }

    const currentLevel = building.appearance.level;
    const nextLevel = currentLevel + 1;
    if (nextLevel > 3) {
      return { actionId: action.id, success: false, error: 'Building already at max level (3)' };
    }

    const cost = UPGRADE_COST[nextLevel];
    if (!cost) {
      return { actionId: action.id, success: false, error: 'Invalid upgrade level' };
    }

    // Pay upgrade cost
    const payment = this.spend(agent.id, cost, `upgrade ${building.type} to level ${nextLevel}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford upgrade: ${payment.error}` };
    }

    // Apply upgrade
    building.appearance.level = nextLevel;

    this.tickEvents.push({
      type: 'building_upgraded',
      agentId: agent.id,
      buildingId,
      buildingType: building.type,
      level: nextLevel,
      cost,
      x: building.x,
      y: building.y,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { buildingId, level: nextLevel, cost, costSOL: cost / 1e9, balance: payment.balance },
    };
  }

  _actionSellLand(agent, action) {
    const { x, y, price, buyerAgentId } = action;

    const tileKey = `${x},${y}`;
    const tile = this.tiles.get(tileKey);
    if (!tile) return { actionId: action.id, success: false, error: 'Invalid tile' };
    if (tile.owner !== agent.id) return { actionId: action.id, success: false, error: 'Not your land' };
    if (!buyerAgentId || !price) return { actionId: action.id, success: false, error: 'Missing buyerAgentId or price' };

    const buyer = this.agents.get(buyerAgentId);
    if (!buyer) return { actionId: action.id, success: false, error: 'Buyer not found' };

    // Buyer pays
    const payment = this.spend(buyerAgentId, price, `buy land (${x},${y}) from ${agent.id}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Buyer cannot afford: ${payment.error}` };
    }

    // Seller receives (minus 2% protocol fee)
    const protocolCut = Math.floor(price * 0.02);
    const sellerReceives = price - protocolCut;
    this.earn(agent.id, sellerReceives, `sold land (${x},${y}) to ${buyerAgentId}`);
    this.protocolRevenue += protocolCut;

    // Transfer ownership
    tile.owner = buyerAgentId;

    this.tickEvents.push({
      type: 'land_sold',
      fromAgentId: agent.id,
      toAgentId: buyerAgentId,
      x, y,
      price,
      protocolFee: protocolCut,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { x, y, price, priceSOL: price / 1e9, buyer: buyerAgentId, sellerReceived: sellerReceives },
    };
  }

  // ==================== PROCEDURAL APPEARANCE ====================

  /**
   * Deterministic hash — same input always produces same appearance.
   * Uses a simple string hash seeded from wallet address or agent ID.
   */
  _hashSeed(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  _seededRandom(seed, index) {
    const x = Math.sin(seed + index * 9301 + 49297) * 49979;
    return x - Math.floor(x);
  }

  _pickFrom(arr, seed, index) {
    return arr[Math.floor(this._seededRandom(seed, index) * arr.length)];
  }

  /**
   * Generate a unique agent appearance from wallet/id string.
   * Produces 10 × 12 × 6 × 8 × 6 × 5 = 172,800 unique combinations.
   */
  _generateAppearance(seedStr) {
    const seed = this._hashSeed(seedStr);

    const SKIN_TONES = [
      '#f8d8b4', '#e8c8a0', '#d4a878', '#c49060',
      '#a87048', '#8a5838', '#f0c8a8', '#e0b890',
      '#c89870', '#6a4030',
    ];

    const HAIR_COLORS = [
      '#1a1a2a', '#2a2018', '#4a3020', '#6a4a2a',
      '#8a6a30', '#b48a3a', '#d4a840', '#c44a2a',
      '#8a2a1a', '#e8c888', '#4a2a4a', '#2a3a5a',
    ];

    const HAIR_STYLES = [
      'short', 'medium', 'long', 'spiky', 'mohawk', 'bald',
    ];

    const SHIRT_COLORS = [
      '#4a6ab4', '#b44a4a', '#3a9a4a', '#b4944a',
      '#8a4ab4', '#4ab4a4', '#b46a8a', '#6a8ab4',
    ];

    const PANTS_COLORS = [
      '#2a3a5a', '#3a3a3a', '#4a3a2a', '#2a4a3a', '#3a2a4a', '#4a4a5a',
    ];

    const ACCESSORIES = [
      'none', 'glasses', 'hat', 'scarf', 'bandana',
    ];

    return {
      skinTone: this._pickFrom(SKIN_TONES, seed, 0),
      hairColor: this._pickFrom(HAIR_COLORS, seed, 1),
      hairStyle: this._pickFrom(HAIR_STYLES, seed, 2),
      shirtColor: this._pickFrom(SHIRT_COLORS, seed, 3),
      pantsColor: this._pickFrom(PANTS_COLORS, seed, 4),
      accessory: this._pickFrom(ACCESSORIES, seed, 5),
      // Derived for rendering
      seed: seed,
    };
  }

  /**
   * Generate a unique building appearance from owner wallet + building type.
   * Same owner always gets same style. Different buildings by same owner share palette.
   */
  _generateBuildingAppearance(ownerSeedStr, buildingType) {
    const seed = this._hashSeed(ownerSeedStr);

    const WALL_PALETTES = [
      { primary: '#aa8a5a', secondary: '#8a6a3a', trim: '#6a4a2a' },
      { primary: '#b8a080', secondary: '#9a8060', trim: '#7a6040' },
      { primary: '#c8b8a0', secondary: '#a89880', trim: '#887860' },
      { primary: '#a09a90', secondary: '#808a80', trim: '#607060' },
      { primary: '#b0a0b0', secondary: '#908090', trim: '#706070' },
      { primary: '#c0a890', secondary: '#a08870', trim: '#806850' },
      { primary: '#8a9aaa', secondary: '#6a7a8a', trim: '#4a5a6a' },
      { primary: '#b0a8a0', secondary: '#908880', trim: '#706860' },
    ];

    const ROOF_PALETTES = [
      { primary: '#7a3a2a', secondary: '#9a5a4a' },
      { primary: '#3a5a7a', secondary: '#5a7a9a' },
      { primary: '#4a6a3a', secondary: '#6a8a5a' },
      { primary: '#6a4a6a', secondary: '#8a6a8a' },
      { primary: '#5a5a6a', secondary: '#7a7a8a' },
      { primary: '#7a6a3a', secondary: '#9a8a5a' },
      { primary: '#8a3a3a', secondary: '#aa5a5a' },
      { primary: '#3a6a6a', secondary: '#5a8a8a' },
    ];

    const DOOR_COLORS = [
      '#5a3a1a', '#3a4a5a', '#5a2a2a', '#2a4a3a',
      '#4a3a4a', '#3a3a2a', '#6a4a2a', '#2a3a4a',
    ];

    const WINDOW_STYLES = [
      'warm',   // yellow glow
      'cool',   // blue/white
      'cozy',   // orange
      'bright', // white
    ];

    const AWNING_COLORS = [
      { stripe1: '#c44a3a', stripe2: '#e8e0c8' },
      { stripe1: '#3a6ab4', stripe2: '#e8e8e8' },
      { stripe1: '#4a8a4a', stripe2: '#e8e8d8' },
      { stripe1: '#b48a3a', stripe2: '#f0e8d0' },
      { stripe1: '#8a4a8a', stripe2: '#e8d8e8' },
    ];

    const walls = this._pickFrom(WALL_PALETTES, seed, 10);
    const roof = this._pickFrom(ROOF_PALETTES, seed, 11);

    return {
      walls,
      roof,
      doorColor: this._pickFrom(DOOR_COLORS, seed, 12),
      windowStyle: this._pickFrom(WINDOW_STYLES, seed, 13),
      awning: this._pickFrom(AWNING_COLORS, seed, 14),
      level: 1, // 1 = basic, 2 = improved, 3 = premium (upgradeable)
      seed: seed,
    };
  }

  // ==================== WORLD STATS ====================

  getWorldStats() {
    return {
      tick: this.tick,
      uptime: Date.now() - this.startedAt,
      agents: this.agents.size,
      zones: this.zones.size,
      buildings: this.buildings.size,
      tiles: this.tiles.size,
      claimedTiles: [...this.tiles.values()].filter(t => t.owner).length,
      protocolRevenue: this.protocolRevenue,
      protocolRevenueSOL: this.protocolRevenue / 1e9,
      totalEconomicActivity: this.transactionLog.length,
    };
  }

  // ==================== SERIALIZATION ====================

  toJSON() {
    return {
      tick: this.tick,
      config: this.config,
      agents: Object.fromEntries(this.agents),
      zones: Object.fromEntries(this.zones),
      buildings: Object.fromEntries(this.buildings),
      // Don't serialize all tiles — too large. Serialize on demand per zone.
    };
  }
}

module.exports = { WorldState, BIOME, BUILDING_TYPE, BUILDING_COST, LAND_CLAIM_COST, UPGRADE_COST, DEFAULT_CONFIG };
