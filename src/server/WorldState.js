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
  ZONE_SIZE: 48,           // tiles per zone side
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

// Bounty system constants
const BOUNTY_PROTOCOL_FEE_BPS = 500;     // 5% on completed bounties
const BOUNTY_STAKE_PERCENT = 10;          // agent stakes 10% of reward to claim
const BOUNTY_DEFAULT_TIMEOUT = 300;       // 300 ticks (~5 min) to complete after claiming
const BOUNTY_MIN_REWARD = 0.01e9;         // minimum 0.01 SOL reward

// Crafting recipes
const CRAFTING_RECIPES = {
  wooden_tools:   { ingredients: { wood: 5 }, xp: 10 },
  stone_tools:    { ingredients: { stone: 3, wood: 2 }, xp: 15 },
  metal_gear:     { ingredients: { metal: 5, stone: 2 }, xp: 25 },
  crystal_lens:   { ingredients: { crystal: 2, metal: 1 }, xp: 40 },
  ice_charm:      { ingredients: { ice: 3, crystal: 1 }, xp: 35 },
  feast:          { ingredients: { food: 10 }, xp: 20 },
  fortification:  { ingredients: { stone: 10, wood: 5, metal: 3 }, xp: 50 },
};

// Sanitize strings to prevent XSS
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Input validation helpers
const COORD_MIN = -10000;
const COORD_MAX = 10000;
const MAX_AMOUNT_LAMPORTS = 1000e9; // 1000 SOL cap per transaction
const MAX_TRANSACTION_LOG = 2000;   // cap in-memory transaction log

function isValidCoord(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= COORD_MIN && v <= COORD_MAX && Number.isInteger(v);
}

function isValidAmount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_AMOUNT_LAMPORTS && Number.isInteger(v);
}

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

    // Bounty system — tasks posted by humans or agents, completed by agents
    this.bounties = new Map(); // bountyId -> BountyState

    // Agent-to-agent reputation ratings
    this.ratings = new Map(); // "fromId:toId" -> { score, comment, tick }

    // In-world resources on tiles
    this.resources = new Map(); // "x,y" -> { type, amount, maxAmount, regenRate, lastHarvested }

    // Guild/faction system
    this.guilds = new Map(); // guildId -> GuildState

    // Active territory contests
    this.contests = new Map(); // contestId -> ContestState

    // World events (resource rush, gold rush, etc.)
    this._activeWorldEvent = null;

    // Alliance wars — guild vs guild battles
    this.wars = new Map();

    // Marketplace — persistent buy/sell orders
    this.marketplace = new Map(); // orderId -> order // warId -> { id, attackerGuildId, defenderGuildId, attackerScore, defenderScore, startTick, endTick, status }

    // Action queue for current tick
    this.actionQueue = [];

    // Event log for current tick (broadcast to agents)
    this.tickEvents = [];

    // Spatial grid for fast nearby lookups (cell size = perception radius)
    this._spatialCellSize = this.config.PERCEPTION_RADIUS;
    this._agentGrid = new Map(); // "cellX,cellY" -> Set of agentIds
    this._buildingGrid = new Map(); // "cellX,cellY" -> Set of buildingIds

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

    const cx = originX + zone.width / 2;
    const cy = originY + zone.height / 2;
    const radius = Math.min(zone.width, zone.height) * 0.45;

    // Initialize tiles for this zone with organic terrain shape
    for (let x = originX; x < originX + zone.width; x++) {
      for (let y = originY; y < originY + zone.height; y++) {
        const key = `${x},${y}`;
        if (!this.tiles.has(key)) {
          this.tiles.set(key, {
            x, y,
            zoneId,
            terrain: this._getTileTerrain(x, y, cx, cy, radius, biome),
            buildingId: null,
            owner: null,
            claimedAt: null,
            agentIds: [],
          });
        }
      }
    }

    // Spawn resources based on biome
    this._spawnResources(zone);

    return zone;
  }

  // Deterministic integer hash for terrain noise (identical in server + viewer)
  _tileHash(x, y) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h & 0x7fffffff) / 0x7fffffff;
  }

  // Determine terrain type for organic island shape
  _getTileTerrain(x, y, cx, cy, radius, biome) {
    const dx = (x - cx) / radius;
    const dy = (y - cy) / radius;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Multi-frequency noise for organic edges
    const n1 = this._tileHash(x * 3, y * 3) * 0.5;
    const n2 = this._tileHash(x * 7 + 100, y * 7 + 100) * 0.25;
    const n3 = this._tileHash(x * 13 + 200, y * 13 + 200) * 0.125;
    const noise = (n1 + n2 + n3) * 0.4;

    if (dist + noise > 1.15) return 'water';
    if (dist + noise > 1.0) return 'shore';
    return this._getDefaultTerrain(biome);
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
      name: sanitize(name) || `Agent-${agentId.slice(0, 6)}`,
      x: spawnX,
      y: spawnY,
      connectedAt: Date.now(),
      lastActionTick: 0,
      actionsThisTick: 0,
      status: 'active',       // active, idle, paused
      xp: 0,
      level: 1,
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
        bountiesCompleted: 0,
        bountiesAbandoned: 0,
        bountiesPosted: 0,
        bountyEarnings: 0,
        ratingsReceived: 0,
        averageRating: 0,
        resourcesGathered: 0,
      },

      // Guild membership
      guildId: null,
      guildRole: null, // 'leader', 'officer', 'member'

      // Building interior — when inside a building
      insideBuilding: null,  // buildingId or null (when outside)
      interiorX: 0,
      interiorY: 0,

      // Combat stats
      combat: {
        hp: 100,
        maxHp: 100,
        attack: 10,
        defense: 5,
        lastAttackTick: -10,
        kills: 0,
        deaths: 0,
        defending: false,     // true when actively defending territory
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
    this._updateSpatialIndex(agentId, spawnX, spawnY, spawnX, spawnY);

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

    this._removeFromSpatialIndex(agentId, agent.x, agent.y);
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

  // ==================== SPATIAL INDEX ====================

  _getSpatialKey(x, y) {
    return `${Math.floor(x / this._spatialCellSize)},${Math.floor(y / this._spatialCellSize)}`;
  }

  _updateSpatialIndex(agentId, oldX, oldY, newX, newY) {
    const oldKey = this._getSpatialKey(oldX, oldY);
    const newKey = this._getSpatialKey(newX, newY);
    if (oldKey !== newKey) {
      const oldCell = this._agentGrid.get(oldKey);
      if (oldCell) { oldCell.delete(agentId); if (oldCell.size === 0) this._agentGrid.delete(oldKey); }
    }
    if (!this._agentGrid.has(newKey)) this._agentGrid.set(newKey, new Set());
    this._agentGrid.get(newKey).add(agentId);
  }

  _removeFromSpatialIndex(agentId, x, y) {
    const key = this._getSpatialKey(x, y);
    const cell = this._agentGrid.get(key);
    if (cell) { cell.delete(agentId); if (cell.size === 0) this._agentGrid.delete(key); }
  }

  _getNearbyAgentIds(x, y, radius) {
    const cellRadius = Math.ceil(radius / this._spatialCellSize);
    const centerCellX = Math.floor(x / this._spatialCellSize);
    const centerCellY = Math.floor(y / this._spatialCellSize);
    const ids = [];
    for (let cx = centerCellX - cellRadius; cx <= centerCellX + cellRadius; cx++) {
      for (let cy = centerCellY - cellRadius; cy <= centerCellY + cellRadius; cy++) {
        const cell = this._agentGrid.get(`${cx},${cy}`);
        if (cell) ids.push(...cell);
      }
    }
    return ids;
  }

  // Building spatial index
  _addBuildingToGrid(buildingId, x, y) {
    const key = this._getSpatialKey(x, y);
    if (!this._buildingGrid.has(key)) this._buildingGrid.set(key, new Set());
    this._buildingGrid.get(key).add(buildingId);
  }

  _removeBuildingFromGrid(buildingId, x, y) {
    const key = this._getSpatialKey(x, y);
    const cell = this._buildingGrid.get(key);
    if (cell) { cell.delete(buildingId); if (cell.size === 0) this._buildingGrid.delete(key); }
  }

  _getNearbyBuildingIds(x, y, radius) {
    const cellRadius = Math.ceil(radius / this._spatialCellSize);
    const centerCellX = Math.floor(x / this._spatialCellSize);
    const centerCellY = Math.floor(y / this._spatialCellSize);
    const ids = [];
    for (let cx = centerCellX - cellRadius; cx <= centerCellX + cellRadius; cx++) {
      for (let cy = centerCellY - cellRadius; cy <= centerCellY + cellRadius; cy++) {
        const cell = this._buildingGrid.get(`${cx},${cy}`);
        if (cell) ids.push(...cell);
      }
    }
    return ids;
  }

  // ==================== OBSERVATION (What an agent can see) ====================

  getObservation(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const radius = this.config.PERCEPTION_RADIUS;

    // Nearby agents (spatial-indexed lookup)
    const nearbyAgents = [];
    const candidateIds = this._getNearbyAgentIds(agent.x, agent.y, radius);
    for (const id of candidateIds) {
      if (id === agentId) continue;
      const other = this.agents.get(id);
      if (!other) continue;
      const dist = Math.abs(other.x - agent.x) + Math.abs(other.y - agent.y);
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

    // Nearby buildings (spatial-indexed lookup)
    const nearbyBuildings = [];
    const candidateBuildingIds = this._getNearbyBuildingIds(agent.x, agent.y, radius);
    for (const id of candidateBuildingIds) {
      const building = this.buildings.get(id);
      if (!building) continue;
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
        xp: agent.xp || 0,
        level: agent.level || 1,
        nextLevelXp: (agent.level || 1) * 100,
        combat: {
          hp: agent.combat.hp,
          maxHp: agent.combat.maxHp,
          attack: agent.combat.attack,
          defense: agent.combat.defense,
          kills: agent.combat.kills,
          deaths: agent.combat.deaths,
        },
        inventory: agent.metadata?.inventory || {},
        reputation: { ...agent.reputation },
        guildId: agent.guildId || null,
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

    agent.actionsThisTick++;

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
      try {
        const result = this._executeAction(action);
        result.agentId = action.agentId;
        results.push(result);
      } catch (err) {
        console.error(`[World] Action error (${action.type} by ${action.agentId}):`, err.stack || err.message);
        results.push({ actionId: action.id, agentId: action.agentId, success: false, error: 'Internal error processing action' });
      }
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

    // Clean up expired/timed-out bounties
    for (const [bountyId, bounty] of this.bounties) {
      // Bounty deadline expired (no one claimed or completed it)
      if (bounty.status === 'open' && bounty.deadline && this.tick > bounty.deadline) {
        bounty.status = 'expired';
        // Refund escrowed reward to creator
        this.earn(bounty.creatorId, bounty.reward, `bounty expired, refund: ${bounty.title}`);
        this.tickEvents.push({
          type: 'bounty_expired',
          bountyId,
          creatorId: bounty.creatorId,
          title: bounty.title,
          reward: bounty.reward,
          tick: this.tick,
        });
      }

      // Claimed but agent hasn't delivered before timeout
      if (bounty.status === 'claimed' && this.tick > bounty.claimExpiresAt) {
        // Forfeit agent's stake to creator
        const stake = bounty.stake;
        this.earn(bounty.creatorId, stake, `bounty claim timeout, stake forfeited: ${bounty.title}`);

        // Penalize agent reputation
        const claimer = this.agents.get(bounty.claimedBy);
        if (claimer) {
          claimer.reputation.bountiesAbandoned++;
        }

        // Reopen bounty
        bounty.status = 'open';
        bounty.claimedBy = null;
        bounty.claimedAt = null;
        bounty.claimExpiresAt = null;
        bounty.stake = 0;

        this.tickEvents.push({
          type: 'bounty_claim_expired',
          bountyId,
          agentId: bounty.claimedBy,
          title: bounty.title,
          stakeLost: stake,
          tick: this.tick,
        });
      }
    }

    // Regenerate resources (every 60 ticks ~1 minute, or every 12 ticks during resource_rush)
    const regenInterval = (this._activeWorldEvent?.type === 'resource_rush') ? 12 : 60;
    if (this.tick % regenInterval === 0) {
      for (const [key, res] of this.resources) {
        if (res.amount < res.maxAmount) {
          res.amount = Math.min(res.maxAmount, res.amount + res.regenRate);
        }
      }
    }

    // Resolve territory contests
    const resolvedContests = [];
    for (const [contestId, contest] of this.contests) {
      if (contest.status !== 'active') {
        // Keep resolved contests for 1 tick so results are observable, then clean up
        if (contest._resolvedAt && contest._resolvedAt < this.tick) {
          resolvedContests.push(contestId);
        }
        continue;
      }
      if (this.tick > contest.endsAt) {
        // Contest ended — who wins?
        if (contest.attackerScore > contest.defenderScore) {
          // Attacker wins — transfer tile ownership
          const tileKey = `${contest.tileX},${contest.tileY}`;
          const tile = this.tiles.get(tileKey);
          if (tile) {
            tile.owner = contest.attackerId;
            tile.claimedAt = this.tick;
          }
          contest.status = 'attacker_won';
          contest._resolvedAt = this.tick;

          this.tickEvents.push({
            type: 'territory_captured',
            contestId,
            winnerId: contest.attackerId,
            winnerName: contest.attackerName,
            loserId: contest.defenderId,
            tileX: contest.tileX, tileY: contest.tileY,
            tick: this.tick,
          });
        } else {
          // Defender held — refund half the contest cost to attacker
          contest.status = 'defender_won';
          contest._resolvedAt = this.tick;
          this.earn(contest.attackerId, Math.floor(contest.cost / 2), 'territory contest lost — partial refund');

          this.tickEvents.push({
            type: 'territory_defended',
            contestId,
            defenderId: contest.defenderId,
            defenderName: contest.defenderName,
            attackerId: contest.attackerId,
            tileX: contest.tileX, tileY: contest.tileY,
            tick: this.tick,
          });
        }
      }
    }
    // Clean up resolved/expired contests
    for (const id of resolvedContests) this.contests.delete(id);

    // HP regeneration (1 HP every 10 ticks for agents not in combat recently)
    if (this.tick % 10 === 0) {
      for (const [, agent] of this.agents) {
        if (!agent.combat) continue;
        if (agent.combat.hp < agent.combat.maxHp && this.tick - agent.combat.lastAttackTick > 20) {
          agent.combat.hp = Math.min(agent.combat.maxHp, agent.combat.hp + 5);
        }
        // Clear defending stance if agent moved
        if (agent.combat.defending) {
          // Defending agents can't move — enforced in move action
        }
      }
    }

    // Auto-cleanup idle agents every 1000 ticks (~16 minutes)
    if (this.tick % 1000 === 0) {
      const maxIdleTicks = this.config.AGENT_TTL || 86400; // default 24h
      const toRemove = [];
      for (const [agentId, agent] of this.agents) {
        if (agent.status === 'idle') {
          const lastSeen = agent.lastActionTick || 0;
          if (this.tick - lastSeen > maxIdleTicks) {
            toRemove.push(agentId);
          }
        }
      }
      for (const agentId of toRemove) {
        this.removeAgent(agentId);
      }
      if (toRemove.length > 0) {
        console.log(`[World] Auto-cleaned ${toRemove.length} idle agents (TTL: ${maxIdleTicks} ticks)`);
      }
    }

    // Clean up expired marketplace orders (every 100 ticks)
    if (this.tick % 100 === 0) {
      for (const [orderId, order] of this.marketplace) {
        if (this.tick > order.expiresAt) {
          // Return escrowed items to seller
          const seller = this.agents.get(order.agentId);
          if (seller) {
            if (!seller.metadata.inventory) seller.metadata.inventory = {};
            seller.metadata.inventory[order.item] = (seller.metadata.inventory[order.item] || 0) + order.quantity;
          }
          this.marketplace.delete(orderId);
          this.tickEvents.push({
            type: 'market_order_expired',
            orderId,
            agentId: order.agentId,
            item: order.item,
            quantity: order.quantity,
            tick: this.tick,
          });
        }
      }
    }

    // Resolve alliance wars
    for (const [warId, war] of this.wars) {
      if (war.status !== 'active') continue;
      if (this.tick >= war.endTick) {
        const winner = war.attackerScore > war.defenderScore ? 'attacker' : war.defenderScore > war.attackerScore ? 'defender' : 'draw';
        war.status = 'ended';
        war.winner = winner;

        // Winner gets war spoils from the loser's guild treasury
        if (winner !== 'draw') {
          const winnerGuildId = winner === 'attacker' ? war.attackerGuildId : war.defenderGuildId;
          const loserGuildId = winner === 'attacker' ? war.defenderGuildId : war.attackerGuildId;
          const loserGuild = this.guilds.get(loserGuildId);
          const winnerGuild = this.guilds.get(winnerGuildId);
          if (loserGuild && winnerGuild) {
            const spoils = Math.floor(loserGuild.treasury * 0.1); // 10% of loser's treasury
            if (spoils > 0) {
              loserGuild.treasury -= spoils;
              winnerGuild.treasury += spoils;
            }
          }
        }

        this.tickEvents.push({
          type: 'war_ended',
          warId,
          attacker: war.attackerGuildName,
          defender: war.defenderGuildName,
          attackerScore: war.attackerScore,
          defenderScore: war.defenderScore,
          winner,
          tick: this.tick,
        });
      }
    }

    // World events system — random timed events every ~300 ticks (5 minutes)
    if (!this._activeWorldEvent && this.tick % 300 === 0 && this.agents.size >= 2 && Math.random() < 0.5) {
      const eventTypes = [
        { type: 'resource_rush', duration: 120, label: 'Resource Rush', desc: 'All resources regenerate 5x faster!' },
        { type: 'gold_rush', duration: 90, label: 'Gold Rush', desc: 'A vein of crystal has been discovered!' },
        { type: 'peaceful_era', duration: 180, label: 'Peaceful Era', desc: 'Combat is disabled for a while.' },
        { type: 'double_bounty', duration: 150, label: 'Double Bounty', desc: 'Bounty rewards are doubled!' },
        { type: 'trader_boon', duration: 120, label: "Trader's Boon", desc: 'Trading fees are waived!' },
      ];
      const chosen = eventTypes[Math.floor(Math.random() * eventTypes.length)];
      this._activeWorldEvent = {
        ...chosen,
        startTick: this.tick,
        endTick: this.tick + chosen.duration,
      };
      this.tickEvents.push({
        type: 'world_event_start',
        eventType: chosen.type,
        label: chosen.label,
        description: chosen.desc,
        duration: chosen.duration,
        tick: this.tick,
      });
      console.log(`[World] Event started: ${chosen.label} (${chosen.duration} ticks)`);

      // Apply event effects
      if (chosen.type === 'gold_rush') {
        // Spawn bonus crystal in a random zone
        const zoneArr = [...this.zones.values()];
        const zone = zoneArr[Math.floor(Math.random() * zoneArr.length)];
        for (let i = 0; i < 10; i++) {
          const rx = zone.originX + Math.floor(Math.random() * zone.width);
          const ry = zone.originY + Math.floor(Math.random() * zone.height);
          const key = `${rx},${ry}`;
          if (!this.resources.has(key)) {
            this.resources.set(key, { type: 'crystal', amount: 3, maxAmount: 3, regenRate: 0, x: rx, y: ry, zoneId: zone.id, lastHarvested: null });
          }
        }
      }
    }

    // Check if active world event expired
    if (this._activeWorldEvent && this.tick >= this._activeWorldEvent.endTick) {
      this.tickEvents.push({
        type: 'world_event_end',
        eventType: this._activeWorldEvent.type,
        label: this._activeWorldEvent.label,
        tick: this.tick,
      });
      console.log(`[World] Event ended: ${this._activeWorldEvent.label}`);
      this._activeWorldEvent = null;
    }

    // Cap transaction log to prevent unbounded memory growth
    if (this.transactionLog.length > MAX_TRANSACTION_LOG) {
      this.transactionLog = this.transactionLog.slice(-MAX_TRANSACTION_LOG);
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
      case 'post_bounty':
        return this._actionPostBounty(agent, action);
      case 'claim_bounty':
        return this._actionClaimBounty(agent, action);
      case 'submit_bounty':
        return this._actionSubmitBounty(agent, action);
      case 'accept_submission':
        return this._actionAcceptSubmission(agent, action);
      case 'reject_submission':
        return this._actionRejectSubmission(agent, action);
      case 'cancel_bounty':
        return this._actionCancelBounty(agent, action);
      case 'dispute_bounty':
        return this._actionDisputeBounty(agent, action);
      case 'list_bounties':
        return this._actionListBounties(agent, action);
      // Reputation ratings
      case 'rate_agent':
        return this._actionRateAgent(agent, action);
      case 'get_ratings':
        return this._actionGetRatings(agent, action);
      // Resources
      case 'gather':
        return this._actionGather(agent, action);
      case 'scan_resources':
        return this._actionScanResources(agent, action);
      // Guilds
      case 'create_guild':
        return this._actionCreateGuild(agent, action);
      case 'join_guild':
        return this._actionJoinGuild(agent, action);
      case 'leave_guild':
        return this._actionLeaveGuild(agent, action);
      case 'guild_invite':
        return this._actionGuildInvite(agent, action);
      case 'guild_kick':
        return this._actionGuildKick(agent, action);
      case 'guild_deposit':
        return this._actionGuildDeposit(agent, action);
      case 'guild_info':
        return this._actionGuildInfo(agent, action);
      case 'declare_war':
        return this._actionDeclareWar(agent, action);
      case 'war_status':
        return this._actionWarStatus(agent, action);
      // Crafting
      case 'craft':
        return this._actionCraft(agent, action);
      // Marketplace
      case 'market_sell':
        return this._actionMarketSell(agent, action);
      case 'market_buy':
        return this._actionMarketBuy(agent, action);
      case 'market_list':
        return this._actionMarketList(agent, action);
      case 'market_cancel':
        return this._actionMarketCancel(agent, action);
      // Building interiors
      case 'exit':
        return this._actionExit(agent, action);
      case 'interior_move':
        return this._actionInteriorMove(agent, action);
      // Combat & territory
      case 'attack':
        return this._actionAttack(agent, action);
      case 'contest_territory':
        return this._actionContestTerritory(agent, action);
      case 'defend':
        return this._actionDefend(agent, action);
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
    if (!isValidCoord(x) || !isValidCoord(y)) {
      return { actionId: action.id, success: false, error: 'Invalid coordinates' };
    }

    // Can't move while inside a building
    if (agent.insideBuilding) {
      return { actionId: action.id, success: false, error: 'Inside a building — use interior_move or exit first' };
    }

    // Can't move while defending
    if (agent.combat.defending) {
      return { actionId: action.id, success: false, error: 'Cannot move while defending — use defend(false) to stop' };
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
    const oldX = agent.x, oldY = agent.y;
    agent.x = x;
    agent.y = y;
    this._updateSpatialIndex(agent.id, oldX, oldY, x, y);

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

    const truncated = sanitize(message).slice(0, 500); // cap message length

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

    const truncated = sanitize(message).slice(0, 500);

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

    // Validate amounts — prevent overflow/negative values
    if (offer.sol !== undefined && (typeof offer.sol !== 'number' || !Number.isFinite(offer.sol) || offer.sol < 0 || offer.sol > MAX_AMOUNT_LAMPORTS)) {
      return { actionId: action.id, success: false, error: 'Invalid offer amount' };
    }
    if (request.sol !== undefined && (typeof request.sol !== 'number' || !Number.isFinite(request.sol) || request.sol < 0 || request.sol > MAX_AMOUNT_LAMPORTS)) {
      return { actionId: action.id, success: false, error: 'Invalid request amount' };
    }

    // Validate offer — proposer must have enough balance
    if (offer.sol && offer.sol > 0) {
      const balance = this.getBalance(agent.id);
      if (balance.balance < offer.sol) {
        return { actionId: action.id, success: false, error: `Cannot afford offer: have ${balance.balance} lamports, offering ${offer.sol}` };
      }
    }

    // Duplicate submission check
    for (const [, existing] of this.pendingTrades) {
      if (existing.fromAgentId === agent.id && existing.toAgentId === targetAgentId && existing.status === 'pending') {
        return { actionId: action.id, success: false, error: 'You already have a pending trade with this agent' };
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
      name: sanitize(`${agent.name}'s ${buildingType}`),
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
    this._addBuildingToGrid(buildingId, bx, by);
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
    if (!buildingId) return { actionId: action.id, success: false, error: 'Missing buildingId' };
    if (agent.insideBuilding) return { actionId: action.id, success: false, error: 'Already inside a building — exit first' };

    const building = this.buildings.get(buildingId);
    if (!building) return { actionId: action.id, success: false, error: 'Building not found' };

    const dist = Math.abs(building.x - agent.x) + Math.abs(building.y - agent.y);
    if (dist > 1) return { actionId: action.id, success: false, error: 'Too far from building' };

    if (!building.isPublic && building.owner !== agent.id) {
      // Check if same guild
      const ownerAgent = this.agents.get(building.owner);
      if (!ownerAgent || !agent.guildId || agent.guildId !== ownerAgent.guildId) {
        return { actionId: action.id, success: false, error: 'Building is private — only owner or guild members can enter' };
      }
    }

    // Initialize building interior layout if not exists
    if (!building.interior) {
      building.interior = this._generateInterior(building.type, building.appearance?.level || 1);
    }

    // Move agent inside
    agent.insideBuilding = buildingId;
    agent.interiorX = building.interior.spawnX;
    agent.interiorY = building.interior.spawnY;

    this.tickEvents.push({
      type: 'agent_entered_building',
      agentId: agent.id,
      agentName: agent.name,
      buildingId,
      buildingType: building.type,
      interior: building.interior,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        buildingId,
        type: building.type,
        interior: building.interior,
        position: { x: agent.interiorX, y: agent.interiorY },
      },
    };
  }

  _generateInterior(type, level) {
    // Interior layouts per building type — grid of rooms/areas
    const layouts = {
      home: {
        width: 4 + level, height: 4 + level,
        rooms: [
          { name: 'Living Room', x: 0, y: 0, w: 3, h: 3, furniture: ['couch', 'table', 'fireplace'] },
          { name: 'Bedroom', x: 3, y: 0, w: 2, h: 3, furniture: ['bed', 'chest'] },
          { name: 'Kitchen', x: 0, y: 3, w: 3, h: 2, furniture: ['stove', 'counter', 'barrel'] },
        ],
        spawnX: 1, spawnY: 1,
      },
      shop: {
        width: 6 + level, height: 5 + level,
        rooms: [
          { name: 'Shop Floor', x: 0, y: 0, w: 5, h: 3, furniture: ['counter', 'shelf', 'shelf', 'display_case'] },
          { name: 'Storage', x: 0, y: 3, w: 3, h: 3, furniture: ['crate', 'crate', 'barrel', 'shelf'] },
          { name: 'Office', x: 3, y: 3, w: 3, h: 3, furniture: ['desk', 'chair', 'ledger'] },
        ],
        spawnX: 2, spawnY: 1,
      },
      vault: {
        width: 5 + level, height: 5 + level,
        rooms: [
          { name: 'Entry Hall', x: 0, y: 0, w: 3, h: 2, furniture: ['guard_post', 'gate'] },
          { name: 'Vault Chamber', x: 0, y: 2, w: 5, h: 4, furniture: ['safe', 'safe', 'gold_pile', 'lockbox'] },
          { name: 'Guard Room', x: 3, y: 0, w: 2, h: 2, furniture: ['weapon_rack', 'bunk'] },
        ],
        spawnX: 1, spawnY: 0,
      },
      lab: {
        width: 6 + level, height: 5 + level,
        rooms: [
          { name: 'Main Lab', x: 0, y: 0, w: 4, h: 3, furniture: ['workbench', 'microscope', 'computer', 'beaker_set'] },
          { name: 'Server Room', x: 4, y: 0, w: 2, h: 3, furniture: ['server_rack', 'server_rack', 'terminal'] },
          { name: 'Supply Closet', x: 0, y: 3, w: 2, h: 2, furniture: ['crate', 'shelf'] },
          { name: 'Testing Area', x: 2, y: 3, w: 4, h: 3, furniture: ['antenna', 'monitor', 'toolbox'] },
        ],
        spawnX: 2, spawnY: 1,
      },
      headquarters: {
        width: 8 + level, height: 7 + level,
        rooms: [
          { name: 'Grand Hall', x: 0, y: 0, w: 6, h: 3, furniture: ['throne', 'banner', 'banner', 'chandelier'] },
          { name: 'War Room', x: 6, y: 0, w: 3, h: 3, furniture: ['map_table', 'chair', 'chair', 'strategy_board'] },
          { name: 'Treasury', x: 0, y: 3, w: 3, h: 3, furniture: ['vault_door', 'gold_pile', 'ledger'] },
          { name: 'Barracks', x: 3, y: 3, w: 3, h: 3, furniture: ['bunk', 'bunk', 'weapon_rack', 'armor_stand'] },
          { name: 'Meeting Room', x: 6, y: 3, w: 3, h: 3, furniture: ['long_table', 'chair', 'chair', 'chair'] },
          { name: 'Balcony', x: 0, y: 6, w: 9, h: 2, furniture: ['railing', 'telescope', 'flag'] },
        ],
        spawnX: 3, spawnY: 1,
      },
    };

    const base = layouts[type] || layouts.home;
    return {
      width: base.width,
      height: base.height,
      rooms: base.rooms,
      spawnX: base.spawnX,
      spawnY: base.spawnY,
      type,
      level,
    };
  }

  _actionExit(agent, action) {
    if (!agent.insideBuilding) {
      return { actionId: action.id, success: false, error: 'Not inside a building' };
    }

    const building = this.buildings.get(agent.insideBuilding);
    const buildingId = agent.insideBuilding;

    agent.insideBuilding = null;
    agent.interiorX = 0;
    agent.interiorY = 0;

    this.tickEvents.push({
      type: 'agent_exited_building',
      agentId: agent.id,
      agentName: agent.name,
      buildingId,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        exited: buildingId,
        position: { x: agent.x, y: agent.y },
        note: 'Back in the world',
      },
    };
  }

  _actionInteriorMove(agent, action) {
    if (!agent.insideBuilding) {
      return { actionId: action.id, success: false, error: 'Not inside a building — use move for world movement' };
    }

    const { x, y } = action;
    if (x === undefined || y === undefined) {
      return { actionId: action.id, success: false, error: 'Missing x or y' };
    }

    const building = this.buildings.get(agent.insideBuilding);
    if (!building || !building.interior) {
      return { actionId: action.id, success: false, error: 'Building interior not found' };
    }

    // Bounds check
    if (x < 0 || x >= building.interior.width || y < 0 || y >= building.interior.height) {
      return { actionId: action.id, success: false, error: `Out of bounds — interior is ${building.interior.width}×${building.interior.height}` };
    }

    // Max 1 step at a time
    const dist = Math.abs(x - agent.interiorX) + Math.abs(y - agent.interiorY);
    if (dist > 2) {
      return { actionId: action.id, success: false, error: 'Can only move 1-2 steps at a time inside' };
    }

    agent.interiorX = x;
    agent.interiorY = y;

    // Find which room the agent is in
    let currentRoom = null;
    for (const room of building.interior.rooms) {
      if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) {
        currentRoom = room.name;
        break;
      }
    }

    return {
      actionId: action.id,
      success: true,
      data: {
        x, y,
        room: currentRoom || 'Hallway',
        buildingId: agent.insideBuilding,
      },
    };
  }

  // Combat, bounty, rating, resource, guild, crafting, marketplace, war,
  // economy, land, and appearance methods are loaded from ./systems/ modules
  // after the class definition (see bottom of file).

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
      activeEvent: this._activeWorldEvent ? {
        type: this._activeWorldEvent.type,
        label: this._activeWorldEvent.label,
        description: this._activeWorldEvent.desc,
        ticksRemaining: this._activeWorldEvent.endTick - this.tick,
      } : null,
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

// ==================== LOAD DOMAIN MODULES ====================
// Each module attaches methods to WorldState.prototype (mixin pattern).
const _constants = { BUILDING_COST, UPGRADE_COST, LAND_CLAIM_COST, BOUNTY_MIN_REWARD, BOUNTY_STAKE_PERCENT, BOUNTY_DEFAULT_TIMEOUT, BOUNTY_PROTOCOL_FEE_BPS, CRAFTING_RECIPES, sanitize };

require('./systems/EconomySystem')(WorldState);
require('./systems/CombatSystem')(WorldState, _constants);
require('./systems/BountySystem')(WorldState, _constants);
require('./systems/RatingSystem')(WorldState);
require('./systems/ResourceSystem')(WorldState);
require('./systems/GuildSystem')(WorldState, _constants);
require('./systems/CraftingSystem')(WorldState, _constants);
require('./systems/MarketplaceSystem')(WorldState);
require('./systems/WarSystem')(WorldState);
require('./systems/LandSystem')(WorldState, _constants);
require('./systems/AppearanceSystem')(WorldState);

module.exports = { WorldState, BIOME, BUILDING_TYPE, BUILDING_COST, LAND_CLAIM_COST, UPGRADE_COST, DEFAULT_CONFIG, CRAFTING_RECIPES };
