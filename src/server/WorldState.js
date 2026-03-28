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

// Bounty system constants
const BOUNTY_PROTOCOL_FEE_BPS = 500;     // 5% on completed bounties
const BOUNTY_STAKE_PERCENT = 10;          // agent stakes 10% of reward to claim
const BOUNTY_DEFAULT_TIMEOUT = 300;       // 300 ticks (~5 min) to complete after claiming
const BOUNTY_MIN_REWARD = 0.01e9;         // minimum 0.01 SOL reward

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

    // Regenerate resources (every 60 ticks ~1 minute)
    if (this.tick % 60 === 0) {
      for (const [key, res] of this.resources) {
        if (res.amount < res.maxAmount) {
          res.amount = Math.min(res.maxAmount, res.amount + res.regenRate);
        }
      }
    }

    // Resolve territory contests
    for (const [contestId, contest] of this.contests) {
      if (contest.status !== 'active') continue;
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

    // HP regeneration (1 HP every 10 ticks for agents not in combat recently)
    if (this.tick % 10 === 0) {
      for (const [, agent] of this.agents) {
        if (agent.combat.hp < agent.combat.maxHp && this.tick - agent.combat.lastAttackTick > 20) {
          agent.combat.hp = Math.min(agent.combat.maxHp, agent.combat.hp + 5);
        }
        // Clear defending stance if agent moved
        if (agent.combat.defending) {
          // Defending agents can't move — enforced in move action
        }
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

  // ==================== COMBAT & TERRITORY CONTESTATION ====================

  _actionAttack(agent, action) {
    const { targetAgentId } = action;
    if (!targetAgentId) return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    if (targetAgentId === agent.id) return { actionId: action.id, success: false, error: 'Cannot attack yourself' };

    const target = this.agents.get(targetAgentId);
    if (!target) return { actionId: action.id, success: false, error: 'Target agent not found' };

    // Must be nearby
    const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
    if (dist > 2) return { actionId: action.id, success: false, error: 'Target too far (max 2 tiles)' };

    // Cannot attack inside buildings
    if (agent.insideBuilding) return { actionId: action.id, success: false, error: 'Cannot attack inside buildings' };

    // Cooldown — 5 ticks between attacks
    if (this.tick - agent.combat.lastAttackTick < 5) {
      return { actionId: action.id, success: false, error: `Attack cooldown — wait ${5 - (this.tick - agent.combat.lastAttackTick)} ticks` };
    }

    // Cannot attack same guild members
    if (agent.guildId && agent.guildId === target.guildId) {
      return { actionId: action.id, success: false, error: 'Cannot attack guild members' };
    }

    // Calculate damage
    const baseDamage = agent.combat.attack;
    const defense = target.combat.defending ? target.combat.defense * 2 : target.combat.defense;
    const damage = Math.max(1, baseDamage - defense + Math.floor(Math.random() * 5));

    target.combat.hp -= damage;
    agent.combat.lastAttackTick = this.tick;

    const killed = target.combat.hp <= 0;

    if (killed) {
      // Agent "defeated" — respawn at zone center with full HP
      target.combat.hp = target.combat.maxHp;
      target.combat.deaths++;
      agent.combat.kills++;

      // Defeated agent drops 10% of their balance as loot
      const lootAmount = Math.floor(this.getBalance(target.id).balance * 0.1);
      if (lootAmount > 0) {
        this.spend(target.id, lootAmount, `defeated by ${agent.name} — loot dropped`);
        this.protocolRevenue -= lootAmount; // undo protocol revenue from spend
        this.earn(agent.id, lootAmount, `defeated ${target.name} — loot collected`);
      }

      // Respawn defeated agent at zone center
      const tile = this.tiles.get(`${target.x},${target.y}`);
      const zone = tile ? this.zones.get(tile.zoneId) : [...this.zones.values()][0];
      if (zone) {
        target.x = zone.originX + Math.floor(zone.width / 2);
        target.y = zone.originY + Math.floor(zone.height / 2);
      }

      this.tickEvents.push({
        type: 'agent_defeated',
        attackerId: agent.id,
        attackerName: agent.name,
        defeatedId: target.id,
        defeatedName: target.name,
        loot: lootAmount,
        lootSOL: lootAmount / 1e9,
        tick: this.tick,
      });
    }

    this.tickEvents.push({
      type: 'combat_attack',
      attackerId: agent.id,
      attackerName: agent.name,
      targetId: target.id,
      targetName: target.name,
      damage,
      targetHp: target.combat.hp,
      targetMaxHp: target.combat.maxHp,
      killed,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        target: target.name,
        damage,
        targetHp: target.combat.hp,
        targetMaxHp: target.combat.maxHp,
        killed,
        loot: killed ? Math.floor(this.getBalance(target.id).balance * 0) : 0, // already transferred
      },
    };
  }

  _actionDefend(agent, action) {
    const { active } = action;
    agent.combat.defending = active !== false; // default true

    if (agent.combat.defending) {
      // Defending doubles defense but agent can't move
      // Also boosts defender score in any active contest on nearby tiles
      for (const [, contest] of this.contests) {
        if (contest.status === 'active' && contest.defenderId === agent.id) {
          const dist = Math.abs(contest.tileX - agent.x) + Math.abs(contest.tileY - agent.y);
          if (dist <= 2) {
            contest.defenderScore += 15; // significant defense boost
          }
        }
      }

      this.tickEvents.push({
        type: 'agent_defending',
        agentId: agent.id,
        agentName: agent.name,
        x: agent.x, y: agent.y,
        tick: this.tick,
      });
    }

    return {
      actionId: action.id,
      success: true,
      data: {
        defending: agent.combat.defending,
        defense: agent.combat.defending ? agent.combat.defense * 2 : agent.combat.defense,
        note: agent.combat.defending ? 'Defense doubled — you cannot move while defending' : 'Defense stance dropped',
      },
    };
  }

  _actionContestTerritory(agent, action) {
    const { x, y } = action;
    const cx = x !== undefined ? x : agent.x;
    const cy = y !== undefined ? y : agent.y;

    const tileKey = `${cx},${cy}`;
    const tile = this.tiles.get(tileKey);
    if (!tile) return { actionId: action.id, success: false, error: 'Invalid tile' };

    // Must be nearby
    const dist = Math.abs(cx - agent.x) + Math.abs(cy - agent.y);
    if (dist > 2) return { actionId: action.id, success: false, error: 'Too far to contest (max 2 tiles)' };

    // Must be owned by someone else
    if (!tile.owner) return { actionId: action.id, success: false, error: 'Tile is unclaimed — use claim instead' };
    if (tile.owner === agent.id) return { actionId: action.id, success: false, error: 'You already own this tile' };

    // Same guild can't contest each other
    const owner = this.agents.get(tile.owner);
    if (owner && agent.guildId && agent.guildId === owner.guildId) {
      return { actionId: action.id, success: false, error: 'Cannot contest guild member territory' };
    }

    // Check for existing contest on this tile
    for (const [, contest] of this.contests) {
      if (contest.tileX === cx && contest.tileY === cy && contest.status === 'active') {
        return { actionId: action.id, success: false, error: 'Territory already being contested' };
      }
    }

    // Contesting costs SOL (0.02 SOL — double claim cost)
    const contestCost = 0.02e9;
    const payment = this.spend(agent.id, contestCost, `contest territory (${cx},${cy})`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford contest (0.02 SOL): ${payment.error}` };
    }

    // Create contest — lasts 30 ticks
    // During contest, the defender can "defend" action to keep it
    // If no defense, attacker wins and takes the tile
    const contestId = require('uuid').v4();
    const contest = {
      id: contestId,
      tileX: cx,
      tileY: cy,
      attackerId: agent.id,
      attackerName: agent.name,
      defenderId: tile.owner,
      defenderName: owner ? owner.name : 'Unknown',
      attackerGuild: agent.guildId,
      defenderGuild: owner ? owner.guildId : null,
      status: 'active',          // active, attacker_won, defender_won, expired
      attackerScore: 10,         // attacker starts with initiative
      defenderScore: 0,          // defender must act to score points
      startedAt: this.tick,
      endsAt: this.tick + 30,    // 30 ticks to resolve
      cost: contestCost,
    };

    this.contests.set(contestId, contest);

    this.tickEvents.push({
      type: 'territory_contested',
      contestId,
      attackerId: agent.id,
      attackerName: agent.name,
      defenderId: tile.owner,
      tileX: cx, tileY: cy,
      endsAt: contest.endsAt,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        contestId,
        tileX: cx, tileY: cy,
        defender: contest.defenderName,
        endsAt: contest.endsAt,
        ticksRemaining: 30,
        cost: contestCost,
        costSOL: contestCost / 1e9,
        note: 'Contest started. Defender has 30 ticks to defend. If undefended, you take the tile.',
      },
    };
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

  // ==================== BOUNTY SYSTEM ====================

  /**
   * Post a bounty — lock reward in escrow, make it visible to agents.
   * Can be posted by agents or via the REST API (for humans).
   */
  _actionPostBounty(agent, action) {
    const { title, description, reward, rewardSOL, deadline, tags, minReputation, maxClaims } = action;

    if (!title) return { actionId: action.id, success: false, error: 'Missing bounty title' };
    if (!description) return { actionId: action.id, success: false, error: 'Missing bounty description' };

    const rewardLamports = reward || (rewardSOL ? Math.floor(rewardSOL * 1e9) : 0);
    if (rewardLamports < BOUNTY_MIN_REWARD) {
      return { actionId: action.id, success: false, error: `Minimum reward is ${BOUNTY_MIN_REWARD / 1e9} SOL` };
    }

    // Lock reward in escrow (deduct from creator's balance)
    const payment = this.spend(agent.id, rewardLamports, `bounty escrow: ${title}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford bounty reward: ${payment.error}` };
    }

    const bountyId = require('uuid').v4();
    const bounty = {
      id: bountyId,
      title: title.slice(0, 200),
      description: description.slice(0, 2000),
      reward: rewardLamports,
      creatorId: agent.id,
      creatorName: agent.name,
      creatorWallet: agent.wallet,
      status: 'open',                // open, claimed, submitted, completed, expired, cancelled
      tags: tags || [],
      minReputation: minReputation || 0,
      maxClaims: maxClaims || 1,      // how many agents can attempt (default 1)
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      stake: 0,
      submission: null,
      submittedAt: null,
      completedAt: null,
      deadline: deadline ? this.tick + deadline : this.tick + 3000, // default ~50 min
      createdAt: this.tick,
      createdAtTime: Date.now(),
    };

    this.bounties.set(bountyId, bounty);
    agent.reputation.bountiesPosted++;

    this.tickEvents.push({
      type: 'bounty_posted',
      bountyId,
      creatorId: agent.id,
      creatorName: agent.name,
      title: bounty.title,
      reward: rewardLamports,
      rewardSOL: rewardLamports / 1e9,
      deadline: bounty.deadline,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        reward: rewardLamports,
        rewardSOL: rewardLamports / 1e9,
        deadline: bounty.deadline,
        status: 'open',
      },
    };
  }

  /**
   * Claim a bounty — agent commits to completing it, stakes 10% of reward.
   */
  _actionClaimBounty(agent, action) {
    const { bountyId } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.status !== 'open') return { actionId: action.id, success: false, error: `Bounty is ${bounty.status}, not open` };
    if (bounty.creatorId === agent.id) return { actionId: action.id, success: false, error: 'Cannot claim your own bounty' };

    // Check minimum reputation
    if (bounty.minReputation > 0) {
      const rep = agent.reputation.bountiesCompleted - agent.reputation.bountiesAbandoned;
      if (rep < bounty.minReputation) {
        return { actionId: action.id, success: false, error: `Requires reputation ${bounty.minReputation}, you have ${rep}` };
      }
    }

    // Stake 10% of reward
    const stakeAmount = Math.floor(bounty.reward * BOUNTY_STAKE_PERCENT / 100);
    if (stakeAmount > 0) {
      const stakePayment = this.spend(agent.id, stakeAmount, `bounty stake: ${bounty.title}`);
      if (!stakePayment.success) {
        return { actionId: action.id, success: false, error: `Cannot afford stake (${stakeAmount / 1e9} SOL): ${stakePayment.error}` };
      }
    }

    bounty.status = 'claimed';
    bounty.claimedBy = agent.id;
    bounty.claimedAt = this.tick;
    bounty.stake = stakeAmount;
    bounty.claimExpiresAt = this.tick + (action.timeout || BOUNTY_DEFAULT_TIMEOUT);

    this.tickEvents.push({
      type: 'bounty_claimed',
      bountyId,
      agentId: agent.id,
      agentName: agent.name,
      title: bounty.title,
      stake: stakeAmount,
      expiresAt: bounty.claimExpiresAt,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        reward: bounty.reward,
        rewardSOL: bounty.reward / 1e9,
        staked: stakeAmount,
        stakedSOL: stakeAmount / 1e9,
        claimExpiresAt: bounty.claimExpiresAt,
        ticksRemaining: bounty.claimExpiresAt - this.tick,
      },
    };
  }

  /**
   * Submit proof of completion for a claimed bounty.
   */
  _actionSubmitBounty(agent, action) {
    const { bountyId, proof, notes } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };
    if (!proof) return { actionId: action.id, success: false, error: 'Missing proof of completion' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.claimedBy !== agent.id) return { actionId: action.id, success: false, error: 'You have not claimed this bounty' };
    if (bounty.status !== 'claimed') return { actionId: action.id, success: false, error: `Bounty is ${bounty.status}, not claimed` };

    bounty.status = 'submitted';
    bounty.submission = {
      proof: typeof proof === 'string' ? proof.slice(0, 5000) : JSON.stringify(proof).slice(0, 5000),
      notes: notes ? notes.slice(0, 1000) : '',
      submittedBy: agent.id,
      submittedAt: this.tick,
    };
    bounty.submittedAt = this.tick;

    this.tickEvents.push({
      type: 'bounty_submitted',
      bountyId,
      agentId: agent.id,
      agentName: agent.name,
      title: bounty.title,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        status: 'submitted',
        note: 'Waiting for creator to review and accept/reject.',
      },
    };
  }

  /**
   * Creator accepts submission — releases reward to agent, returns stake.
   */
  _actionAcceptSubmission(agent, action) {
    const { bountyId } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.creatorId !== agent.id) return { actionId: action.id, success: false, error: 'Only the bounty creator can accept submissions' };
    if (bounty.status !== 'submitted') return { actionId: action.id, success: false, error: `Bounty is ${bounty.status}, not submitted` };

    // Calculate fee
    const protocolFee = Math.floor(bounty.reward * BOUNTY_PROTOCOL_FEE_BPS / 10000);
    const agentReceives = bounty.reward - protocolFee;

    // Pay the agent (reward minus protocol fee)
    this.earn(bounty.claimedBy, agentReceives, `bounty completed: ${bounty.title}`);

    // Return stake to agent
    if (bounty.stake > 0) {
      this.earn(bounty.claimedBy, bounty.stake, `bounty stake returned: ${bounty.title}`);
    }

    // Protocol collects fee
    this.protocolRevenue += protocolFee;

    // Update reputations
    const claimer = this.agents.get(bounty.claimedBy);
    if (claimer) {
      claimer.reputation.bountiesCompleted++;
      claimer.reputation.bountyEarnings += agentReceives;
    }

    bounty.status = 'completed';
    bounty.completedAt = this.tick;

    this.tickEvents.push({
      type: 'bounty_completed',
      bountyId,
      creatorId: agent.id,
      agentId: bounty.claimedBy,
      title: bounty.title,
      reward: bounty.reward,
      protocolFee,
      agentReceived: agentReceives,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        status: 'completed',
        agentReceived: agentReceives,
        agentReceivedSOL: agentReceives / 1e9,
        protocolFee,
        protocolFeeSOL: protocolFee / 1e9,
        stakeReturned: bounty.stake,
      },
    };
  }

  /**
   * Creator rejects submission — bounty goes back to claimed state, agent can retry.
   */
  _actionRejectSubmission(agent, action) {
    const { bountyId, reason } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.creatorId !== agent.id) return { actionId: action.id, success: false, error: 'Only the bounty creator can reject submissions' };
    if (bounty.status !== 'submitted') return { actionId: action.id, success: false, error: `Bounty is ${bounty.status}, not submitted` };

    // Go back to claimed — agent can try again within the timeout
    bounty.status = 'claimed';
    bounty.submission = null;
    bounty.submittedAt = null;

    this.tickEvents.push({
      type: 'bounty_rejected',
      bountyId,
      creatorId: agent.id,
      agentId: bounty.claimedBy,
      title: bounty.title,
      reason: reason || 'Submission did not meet requirements',
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        status: 'claimed',
        reason: reason || 'Submission rejected. Agent can retry before timeout.',
        ticksRemaining: bounty.claimExpiresAt - this.tick,
      },
    };
  }

  /**
   * Cancel an open bounty — only if no one has claimed it yet.
   */
  _actionCancelBounty(agent, action) {
    const { bountyId } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.creatorId !== agent.id) return { actionId: action.id, success: false, error: 'Only the creator can cancel' };
    if (bounty.status !== 'open') return { actionId: action.id, success: false, error: `Cannot cancel — bounty is ${bounty.status}` };

    // Refund reward
    this.earn(agent.id, bounty.reward, `bounty cancelled, refund: ${bounty.title}`);

    bounty.status = 'cancelled';

    this.tickEvents.push({
      type: 'bounty_cancelled',
      bountyId,
      creatorId: agent.id,
      title: bounty.title,
      refund: bounty.reward,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { bountyId, status: 'cancelled', refunded: bounty.reward, refundedSOL: bounty.reward / 1e9 },
    };
  }

  /**
   * List available bounties — agents can browse open tasks.
   */
  _actionListBounties(agent, action) {
    const { status, tag, limit } = action;
    const filterStatus = status || 'open';
    const maxResults = Math.min(limit || 20, 50);

    let results = [...this.bounties.values()];

    // Filter by status
    if (filterStatus !== 'all') {
      results = results.filter(b => b.status === filterStatus);
    }

    // Filter by tag
    if (tag) {
      results = results.filter(b => b.tags.includes(tag));
    }

    // Sort by reward (highest first)
    results.sort((a, b) => b.reward - a.reward);
    results = results.slice(0, maxResults);

    return {
      actionId: action.id,
      success: true,
      data: {
        bounties: results.map(b => ({
          id: b.id,
          title: b.title,
          description: b.description.slice(0, 200),
          reward: b.reward,
          rewardSOL: b.reward / 1e9,
          status: b.status,
          creatorName: b.creatorName,
          tags: b.tags,
          minReputation: b.minReputation,
          deadline: b.deadline,
          ticksRemaining: b.deadline - this.tick,
          claimedBy: b.claimedBy,
          createdAt: b.createdAt,
        })),
        count: results.length,
        totalBounties: this.bounties.size,
      },
    };
  }

  // ==================== AGENT-TO-AGENT REPUTATION RATINGS ====================

  _actionRateAgent(agent, action) {
    const { targetAgentId, score, comment } = action;
    if (!targetAgentId) return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    if (targetAgentId === agent.id) return { actionId: action.id, success: false, error: 'Cannot rate yourself' };
    if (score === undefined || score < 1 || score > 5) return { actionId: action.id, success: false, error: 'Score must be 1-5' };

    const target = this.agents.get(targetAgentId);
    if (!target) return { actionId: action.id, success: false, error: 'Target agent not found' };

    // Must be within perception range
    const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
    if (dist > this.config.PERCEPTION_RADIUS) {
      return { actionId: action.id, success: false, error: 'Agent too far — must be within perception range' };
    }

    // One rating per pair (can update)
    const ratingKey = `${agent.id}:${targetAgentId}`;
    const existing = this.ratings.get(ratingKey);

    this.ratings.set(ratingKey, {
      fromId: agent.id,
      fromName: agent.name,
      toId: targetAgentId,
      toName: target.name,
      score: Math.floor(score),
      comment: comment ? comment.slice(0, 200) : '',
      tick: this.tick,
      updated: existing ? true : false,
    });

    // Recalculate target's average rating
    let totalScore = 0;
    let count = 0;
    for (const [key, rating] of this.ratings) {
      if (key.endsWith(`:${targetAgentId}`)) {
        totalScore += rating.score;
        count++;
      }
    }
    target.reputation.ratingsReceived = count;
    target.reputation.averageRating = count > 0 ? Math.round((totalScore / count) * 10) / 10 : 0;

    this.tickEvents.push({
      type: 'agent_rated',
      fromAgentId: agent.id,
      toAgentId: targetAgentId,
      score: Math.floor(score),
      averageRating: target.reputation.averageRating,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        targetAgentId,
        targetName: target.name,
        score: Math.floor(score),
        averageRating: target.reputation.averageRating,
        totalRatings: count,
        updated: existing ? true : false,
      },
    };
  }

  _actionGetRatings(agent, action) {
    const { targetAgentId } = action;
    const targetId = targetAgentId || agent.id;
    const target = this.agents.get(targetId);
    if (!target) return { actionId: action.id, success: false, error: 'Agent not found' };

    const ratings = [];
    for (const [key, rating] of this.ratings) {
      if (key.endsWith(`:${targetId}`)) {
        ratings.push({
          fromId: rating.fromId,
          fromName: rating.fromName,
          score: rating.score,
          comment: rating.comment,
          tick: rating.tick,
        });
      }
    }
    ratings.sort((a, b) => b.tick - a.tick);

    return {
      actionId: action.id,
      success: true,
      data: {
        agentId: targetId,
        agentName: target.name,
        averageRating: target.reputation.averageRating,
        totalRatings: target.reputation.ratingsReceived,
        ratings: ratings.slice(0, 20),
      },
    };
  }

  // ==================== IN-WORLD RESOURCES ====================

  _spawnResources(zone) {
    // Resource types per biome
    const biomeResources = {
      village: [
        { type: 'wood', chance: 0.03, amount: 5, max: 10, regen: 1 },
        { type: 'stone', chance: 0.01, amount: 3, max: 6, regen: 0 },
      ],
      autumn_town: [
        { type: 'wood', chance: 0.02, amount: 4, max: 8, regen: 1 },
        { type: 'food', chance: 0.02, amount: 6, max: 10, regen: 2 },
      ],
      farmland: [
        { type: 'food', chance: 0.06, amount: 8, max: 15, regen: 3 },
        { type: 'wood', chance: 0.01, amount: 3, max: 5, regen: 1 },
      ],
      industrial: [
        { type: 'metal', chance: 0.04, amount: 5, max: 10, regen: 0 },
        { type: 'stone', chance: 0.03, amount: 6, max: 12, regen: 0 },
      ],
      wilderness: [
        { type: 'wood', chance: 0.05, amount: 8, max: 15, regen: 2 },
        { type: 'food', chance: 0.02, amount: 4, max: 8, regen: 1 },
        { type: 'stone', chance: 0.01, amount: 3, max: 6, regen: 0 },
      ],
      highlands: [
        { type: 'stone', chance: 0.05, amount: 8, max: 15, regen: 0 },
        { type: 'metal', chance: 0.03, amount: 5, max: 10, regen: 0 },
        { type: 'crystal', chance: 0.005, amount: 2, max: 3, regen: 0 },
      ],
      winter_town: [
        { type: 'wood', chance: 0.02, amount: 3, max: 6, regen: 1 },
        { type: 'ice', chance: 0.03, amount: 5, max: 10, regen: 2 },
      ],
    };

    const defs = biomeResources[zone.biome] || biomeResources.wilderness;

    for (let x = zone.originX; x < zone.originX + zone.width; x++) {
      for (let y = zone.originY; y < zone.originY + zone.height; y++) {
        for (const def of defs) {
          if (Math.random() < def.chance) {
            const key = `${x},${y}`;
            if (!this.resources.has(key)) {
              this.resources.set(key, {
                type: def.type,
                amount: def.amount,
                maxAmount: def.max,
                regenRate: def.regen,
                x, y,
                zoneId: zone.id,
                lastHarvested: null,
              });
            }
            break; // one resource per tile
          }
        }
      }
    }
  }

  _actionGather(agent, action) {
    const { x, y } = action;
    const gx = x !== undefined ? x : agent.x;
    const gy = y !== undefined ? y : agent.y;

    // Must be close
    const dist = Math.abs(gx - agent.x) + Math.abs(gy - agent.y);
    if (dist > 2) return { actionId: action.id, success: false, error: 'Too far to gather (max 2 tiles)' };

    const key = `${gx},${gy}`;
    const resource = this.resources.get(key);
    if (!resource) return { actionId: action.id, success: false, error: 'No resource at this location' };
    if (resource.amount <= 0) return { actionId: action.id, success: false, error: `${resource.type} is depleted — wait for regeneration` };

    // Gather 1-3 units
    const gathered = Math.min(resource.amount, 1 + Math.floor(Math.random() * 3));
    resource.amount -= gathered;
    resource.lastHarvested = this.tick;

    // Add to agent's inventory (stored in metadata)
    if (!agent.metadata.inventory) agent.metadata.inventory = {};
    agent.metadata.inventory[resource.type] = (agent.metadata.inventory[resource.type] || 0) + gathered;
    agent.reputation.resourcesGathered += gathered;

    this.tickEvents.push({
      type: 'resource_gathered',
      agentId: agent.id,
      agentName: agent.name,
      resourceType: resource.type,
      amount: gathered,
      remaining: resource.amount,
      x: gx, y: gy,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        resourceType: resource.type,
        gathered,
        remaining: resource.amount,
        inventory: agent.metadata.inventory,
      },
    };
  }

  _actionScanResources(agent, action) {
    const radius = Math.min(action.radius || 5, this.config.PERCEPTION_RADIUS);
    const nearby = [];

    for (const [key, res] of this.resources) {
      const dist = Math.abs(res.x - agent.x) + Math.abs(res.y - agent.y);
      if (dist <= radius && res.amount > 0) {
        nearby.push({
          type: res.type,
          amount: res.amount,
          maxAmount: res.maxAmount,
          x: res.x,
          y: res.y,
          distance: dist,
        });
      }
    }

    nearby.sort((a, b) => a.distance - b.distance);

    return {
      actionId: action.id,
      success: true,
      data: {
        resources: nearby.slice(0, 20),
        count: nearby.length,
        inventory: agent.metadata.inventory || {},
      },
    };
  }

  // ==================== GUILD / FACTION SYSTEM ====================

  _actionCreateGuild(agent, action) {
    const { name, description, tag } = action;
    if (!name) return { actionId: action.id, success: false, error: 'Missing guild name' };
    if (agent.guildId) return { actionId: action.id, success: false, error: 'Already in a guild — leave first' };

    // Name uniqueness
    for (const [, guild] of this.guilds) {
      if (guild.name.toLowerCase() === name.toLowerCase()) {
        return { actionId: action.id, success: false, error: 'Guild name already taken' };
      }
    }

    // Creation cost
    const cost = 0.1e9; // 0.1 SOL
    const payment = this.spend(agent.id, cost, `create guild: ${name}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford guild creation (0.1 SOL): ${payment.error}` };
    }

    const guildId = require('uuid').v4();
    const guild = {
      id: guildId,
      name: name.slice(0, 30),
      tag: (tag || name.slice(0, 4)).toUpperCase().slice(0, 5),
      description: description ? description.slice(0, 500) : '',
      leaderId: agent.id,
      leaderName: agent.name,
      members: [{ agentId: agent.id, name: agent.name, role: 'leader', joinedAt: this.tick }],
      treasury: 0, // shared guild funds (lamports)
      totalDeposited: 0,
      tilesOwned: 0,
      buildingsOwned: 0,
      createdAt: this.tick,
      invites: new Set(), // agentIds invited
    };

    this.guilds.set(guildId, guild);
    agent.guildId = guildId;
    agent.guildRole = 'leader';

    this.tickEvents.push({
      type: 'guild_created',
      guildId,
      guildName: guild.name,
      guildTag: guild.tag,
      leaderId: agent.id,
      leaderName: agent.name,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId, name: guild.name, tag: guild.tag, role: 'leader' },
    };
  }

  _actionJoinGuild(agent, action) {
    const { guildId } = action;
    if (!guildId) return { actionId: action.id, success: false, error: 'Missing guildId' };
    if (agent.guildId) return { actionId: action.id, success: false, error: 'Already in a guild — leave first' };

    const guild = this.guilds.get(guildId);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };

    // Must be invited or guild is open (max 20 members)
    if (!guild.invites.has(agent.id)) {
      return { actionId: action.id, success: false, error: 'You need an invite to join this guild' };
    }
    if (guild.members.length >= 20) {
      return { actionId: action.id, success: false, error: 'Guild is full (max 20 members)' };
    }

    guild.invites.delete(agent.id);
    guild.members.push({ agentId: agent.id, name: agent.name, role: 'member', joinedAt: this.tick });
    agent.guildId = guildId;
    agent.guildRole = 'member';

    this.tickEvents.push({
      type: 'guild_joined',
      guildId,
      guildName: guild.name,
      agentId: agent.id,
      agentName: agent.name,
      memberCount: guild.members.length,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId, guildName: guild.name, role: 'member', memberCount: guild.members.length },
    };
  }

  _actionLeaveGuild(agent, action) {
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const guild = this.guilds.get(agent.guildId);
    if (!guild) {
      agent.guildId = null;
      agent.guildRole = null;
      return { actionId: action.id, success: true, data: { note: 'Guild not found, membership cleared' } };
    }

    // Leader can't leave — must transfer or disband
    if (guild.leaderId === agent.id) {
      if (guild.members.length > 1) {
        return { actionId: action.id, success: false, error: 'Leader cannot leave — promote someone first or kick all members' };
      }
      // Last member — disband guild
      this.guilds.delete(guild.id);
      agent.guildId = null;
      agent.guildRole = null;

      this.tickEvents.push({
        type: 'guild_disbanded',
        guildId: guild.id,
        guildName: guild.name,
        tick: this.tick,
      });

      return { actionId: action.id, success: true, data: { note: 'Guild disbanded (you were the last member)' } };
    }

    guild.members = guild.members.filter(m => m.agentId !== agent.id);
    agent.guildId = null;
    agent.guildRole = null;

    this.tickEvents.push({
      type: 'guild_left',
      guildId: guild.id,
      guildName: guild.name,
      agentId: agent.id,
      agentName: agent.name,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId: guild.id, guildName: guild.name, note: 'You left the guild' },
    };
  }

  _actionGuildInvite(agent, action) {
    const { targetAgentId } = action;
    if (!targetAgentId) return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const guild = this.guilds.get(agent.guildId);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };

    // Only leader or officer can invite
    if (agent.guildRole !== 'leader' && agent.guildRole !== 'officer') {
      return { actionId: action.id, success: false, error: 'Only leaders and officers can invite' };
    }

    const target = this.agents.get(targetAgentId);
    if (!target) return { actionId: action.id, success: false, error: 'Target agent not found' };
    if (target.guildId) return { actionId: action.id, success: false, error: 'Agent is already in a guild' };

    guild.invites.add(targetAgentId);

    this.tickEvents.push({
      type: 'guild_invite',
      guildId: guild.id,
      guildName: guild.name,
      fromAgentId: agent.id,
      targetAgentId,
      targetName: target.name,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId: guild.id, guildName: guild.name, invited: targetAgentId, targetName: target.name },
    };
  }

  _actionGuildKick(agent, action) {
    const { targetAgentId } = action;
    if (!targetAgentId) return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const guild = this.guilds.get(agent.guildId);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };
    if (guild.leaderId !== agent.id) return { actionId: action.id, success: false, error: 'Only the leader can kick members' };
    if (targetAgentId === agent.id) return { actionId: action.id, success: false, error: 'Cannot kick yourself' };

    const memberIdx = guild.members.findIndex(m => m.agentId === targetAgentId);
    if (memberIdx === -1) return { actionId: action.id, success: false, error: 'Agent is not in your guild' };

    guild.members.splice(memberIdx, 1);
    const target = this.agents.get(targetAgentId);
    if (target) {
      target.guildId = null;
      target.guildRole = null;
    }

    this.tickEvents.push({
      type: 'guild_kicked',
      guildId: guild.id,
      guildName: guild.name,
      kickedAgentId: targetAgentId,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId: guild.id, kicked: targetAgentId, memberCount: guild.members.length },
    };
  }

  _actionGuildDeposit(agent, action) {
    const { amount, amountSOL } = action;
    const lamports = amount || (amountSOL ? Math.floor(amountSOL * 1e9) : 0);
    if (lamports <= 0) return { actionId: action.id, success: false, error: 'Missing or invalid amount' };
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const guild = this.guilds.get(agent.guildId);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };

    const payment = this.spend(agent.id, lamports, `guild treasury deposit: ${guild.name}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford: ${payment.error}` };
    }

    guild.treasury += lamports;
    guild.totalDeposited += lamports;

    this.tickEvents.push({
      type: 'guild_deposit',
      guildId: guild.id,
      guildName: guild.name,
      agentId: agent.id,
      amount: lamports,
      treasury: guild.treasury,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        guildId: guild.id,
        deposited: lamports,
        depositedSOL: lamports / 1e9,
        treasury: guild.treasury,
        treasurySOL: guild.treasury / 1e9,
      },
    };
  }

  _actionGuildInfo(agent, action) {
    const { guildId } = action;
    const id = guildId || agent.guildId;
    if (!id) return { actionId: action.id, success: false, error: 'Missing guildId and not in a guild' };

    const guild = this.guilds.get(id);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };

    return {
      actionId: action.id,
      success: true,
      data: {
        id: guild.id,
        name: guild.name,
        tag: guild.tag,
        description: guild.description,
        leader: { id: guild.leaderId, name: guild.leaderName },
        members: guild.members.map(m => ({ agentId: m.agentId, name: m.name, role: m.role, joinedAt: m.joinedAt })),
        memberCount: guild.members.length,
        treasury: guild.treasury,
        treasurySOL: guild.treasury / 1e9,
        totalDeposited: guild.totalDeposited,
        createdAt: guild.createdAt,
      },
    };
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
