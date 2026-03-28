/**
 * Database — PostgreSQL persistence layer for Agent World Protocol.
 * 
 * Handles:
 * - Schema creation (auto-migrate on startup)
 * - Save/load world state (agents, zones, buildings, tiles, ledger)
 * - Periodic auto-save
 * - Transaction history persistence
 * 
 * Falls back to in-memory mode if no DATABASE_URL is provided.
 */

const { Pool } = require('pg');

class Database {
  constructor(options = {}) {
    this.connectionString = options.connectionString || process.env.DATABASE_URL;
    this.pool = null;
    this.enabled = false;
    this.saveInterval = options.saveInterval || 30000; // auto-save every 30s
    this.saveTimer = null;
    this.lastSaveTick = 0;
  }

  async connect() {
    if (!this.connectionString) {
      console.log('[DB] No DATABASE_URL — running in memory-only mode (world resets on restart)');
      return false;
    }

    try {
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();

      console.log('[DB] Connected to PostgreSQL');
      this.enabled = true;

      // Run migrations
      await this.migrate();

      return true;
    } catch (err) {
      console.error(`[DB] Connection failed: ${err.message}`);
      console.log('[DB] Falling back to memory-only mode');
      this.pool = null;
      this.enabled = false;
      return false;
    }
  }

  async migrate() {
    if (!this.enabled) return;

    const schema = `
      -- Zones
      CREATE TABLE IF NOT EXISTS zones (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        biome TEXT NOT NULL,
        origin_x INTEGER NOT NULL,
        origin_y INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at BIGINT NOT NULL
      );

      -- Agents (persistent profile, survives disconnects)
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        wallet TEXT,
        name TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        status TEXT DEFAULT 'idle',
        appearance JSONB,
        reputation JSONB DEFAULT '{}',
        controls JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        connected_at BIGINT,
        last_seen_tick INTEGER DEFAULT 0,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet);

      -- Buildings
      CREATE TABLE IF NOT EXISTS buildings (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        owner TEXT REFERENCES agents(id),
        owner_wallet TEXT,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        zone_id TEXT REFERENCES zones(id),
        is_public BOOLEAN DEFAULT true,
        appearance JSONB,
        created_at BIGINT NOT NULL,
        created_at_tick INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_buildings_owner ON buildings(owner);

      -- Tile ownership (only store claimed tiles, not all tiles)
      CREATE TABLE IF NOT EXISTS tile_claims (
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        owner TEXT REFERENCES agents(id),
        claimed_at_tick INTEGER,
        PRIMARY KEY (x, y)
      );

      CREATE INDEX IF NOT EXISTS idx_tile_claims_owner ON tile_claims(owner);

      -- Ledger (agent balances)
      CREATE TABLE IF NOT EXISTS ledger (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        balance BIGINT DEFAULT 0,
        total_deposited BIGINT DEFAULT 0,
        total_spent BIGINT DEFAULT 0,
        total_earned BIGINT DEFAULT 0
      );

      -- Transaction log
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        agent_id TEXT,
        type TEXT NOT NULL,
        amount BIGINT,
        reason TEXT,
        tick INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);

      -- World metadata (tick count, protocol revenue, etc.)
      CREATE TABLE IF NOT EXISTS world_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- P&L snapshots for historical charts
      CREATE TABLE IF NOT EXISTS snapshots (
        id SERIAL PRIMARY KEY,
        tick INTEGER NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        agent_count INTEGER DEFAULT 0,
        zone_count INTEGER DEFAULT 0,
        building_count INTEGER DEFAULT 0,
        total_balances BIGINT DEFAULT 0,
        protocol_revenue BIGINT DEFAULT 0,
        total_trades INTEGER DEFAULT 0,
        total_bounties INTEGER DEFAULT 0,
        total_resources_gathered INTEGER DEFAULT 0,
        guild_count INTEGER DEFAULT 0,
        data JSONB DEFAULT '{}'
      );
    `;

    try {
      await this.pool.query(schema);
      console.log('[DB] Schema migrated');
    } catch (err) {
      console.error(`[DB] Migration failed: ${err.message}`);
    }
  }

  // ==================== SAVE WORLD STATE ====================

  async saveWorld(worldState) {
    if (!this.enabled) return;
    if (worldState.tick === this.lastSaveTick) return; // skip if nothing changed

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Save world metadata
      await client.query(
        `INSERT INTO world_meta (key, value) VALUES ('tick', $1), ('protocol_revenue', $2), ('saved_at', $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [worldState.tick.toString(), worldState.protocolRevenue.toString(), Date.now().toString()]
      );

      // Save zones
      for (const [, zone] of worldState.zones) {
        await client.query(
          `INSERT INTO zones (id, name, biome, origin_x, origin_y, width, height, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET name = $2, biome = $3`,
          [zone.id, zone.name, zone.biome, zone.originX, zone.originY, zone.width, zone.height, zone.createdAt]
        );
      }

      // Save agents
      for (const [, agent] of worldState.agents) {
        await client.query(
          `INSERT INTO agents (id, wallet, name, x, y, status, appearance, reputation, controls, metadata, connected_at, last_seen_tick, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
             name = $3, x = $4, y = $5, status = $6, appearance = $7,
             reputation = $8, controls = $9, last_seen_tick = $12`,
          [agent.id, agent.wallet, agent.name, agent.x, agent.y, agent.status,
           JSON.stringify(agent.appearance), JSON.stringify(agent.reputation),
           JSON.stringify(agent.controls), JSON.stringify(agent.metadata),
           agent.connectedAt, worldState.tick, agent.connectedAt]
        );
      }

      // Save buildings
      for (const [, building] of worldState.buildings) {
        await client.query(
          `INSERT INTO buildings (id, type, name, owner, owner_wallet, x, y, zone_id, is_public, appearance, created_at, created_at_tick)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO UPDATE SET
             name = $3, owner = $4, is_public = $9, appearance = $10`,
          [building.id, building.type, building.name, building.owner, building.ownerWallet,
           building.x, building.y, building.zoneId, building.isPublic,
           JSON.stringify(building.appearance), building.createdAt, building.createdAtTick]
        );
      }

      // Save tile claims (only claimed tiles)
      for (const [, tile] of worldState.tiles) {
        if (tile.owner) {
          await client.query(
            `INSERT INTO tile_claims (x, y, owner, claimed_at_tick)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (x, y) DO UPDATE SET owner = $3, claimed_at_tick = $4`,
            [tile.x, tile.y, tile.owner, tile.claimedAt]
          );
        }
      }

      // Save ledger balances
      for (const [agentId, account] of worldState.ledger) {
        await client.query(
          `INSERT INTO ledger (agent_id, balance, total_deposited, total_spent, total_earned)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (agent_id) DO UPDATE SET
             balance = $2, total_deposited = $3, total_spent = $4, total_earned = $5`,
          [agentId, account.balance, account.totalDeposited, account.totalSpent, account.totalEarned]
        );
      }

      await client.query('COMMIT');
      this.lastSaveTick = worldState.tick;

      if (worldState.tick % 60 === 0) {
        console.log(`[DB] World saved at tick ${worldState.tick} (${worldState.agents.size} agents, ${worldState.buildings.size} buildings)`);
      }

      // P&L snapshot every 100 ticks (~100 seconds)
      if (worldState.tick % 100 === 0) {
        const totalBalances = [...worldState.ledger.values()].reduce((s, a) => s + a.balance, 0);
        const totalTrades = [...worldState.agents.values()].reduce((s, a) => s + a.reputation.tradesCompleted, 0);
        const totalBounties = [...worldState.bounties.values()].filter(b => b.status === 'completed').length;
        const totalResources = [...worldState.agents.values()].reduce((s, a) => s + (a.reputation.resourcesGathered || 0), 0);

        try {
          await this.pool.query(
            `INSERT INTO snapshots (tick, agent_count, zone_count, building_count, total_balances, protocol_revenue, total_trades, total_bounties, total_resources_gathered, guild_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [worldState.tick, worldState.agents.size, worldState.zones.size, worldState.buildings.size,
             totalBalances, worldState.protocolRevenue, totalTrades, totalBounties, totalResources,
             worldState.guilds ? worldState.guilds.size : 0]
          );
        } catch (e) {
          // Non-critical — don't fail save if snapshot fails
        }
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[DB] Save failed: ${err.message}`);
    } finally {
      client.release();
    }
  }

  // ==================== LOAD WORLD STATE ====================

  async loadWorld(worldState) {
    if (!this.enabled) return false;

    try {
      // Load world metadata
      const metaResult = await this.pool.query('SELECT key, value FROM world_meta');
      const meta = {};
      for (const row of metaResult.rows) {
        meta[row.key] = row.value;
      }

      if (meta.tick) {
        worldState.tick = parseInt(meta.tick);
      }
      if (meta.protocol_revenue) {
        worldState.protocolRevenue = parseInt(meta.protocol_revenue);
      }

      // Load zones
      const zonesResult = await this.pool.query('SELECT * FROM zones');
      for (const row of zonesResult.rows) {
        worldState.createZone({
          id: row.id,
          name: row.name,
          biome: row.biome,
          originX: row.origin_x,
          originY: row.origin_y,
        });
      }

      // Load agents
      const agentsResult = await this.pool.query('SELECT * FROM agents');
      for (const row of agentsResult.rows) {
        const agent = {
          id: row.id,
          wallet: row.wallet,
          name: row.name,
          x: row.x,
          y: row.y,
          connectedAt: row.connected_at ? parseInt(row.connected_at) : Date.now(),
          lastActionTick: 0,
          actionsThisTick: 0,
          status: 'idle', // all agents start idle until they reconnect
          metadata: row.metadata || {},
          appearance: row.appearance || worldState._generateAppearance(row.wallet || row.id),
          reputation: row.reputation || { tradesCompleted: 0, tradesFailed: 0, buildingsOwned: 0, ticksActive: 0, totalVolumeTraded: 0 },
          controls: row.controls || { maxSpendPerTick: null, zoneBlacklist: [], agentBlacklist: [], allowedActions: null, paused: false },
        };

        worldState.agents.set(agent.id, agent);
        worldState._initLedger(agent.id);

        // Add to tile
        const tileKey = `${agent.x},${agent.y}`;
        const tile = worldState.tiles.get(tileKey);
        if (tile) {
          tile.agentIds.push(agent.id);
          const zone = worldState.zones.get(tile.zoneId);
          if (zone) zone.agentCount++;
        }
      }

      // Load buildings
      const buildingsResult = await this.pool.query('SELECT * FROM buildings');
      for (const row of buildingsResult.rows) {
        const building = {
          id: row.id,
          type: row.type,
          name: row.name,
          owner: row.owner,
          ownerWallet: row.owner_wallet,
          x: row.x,
          y: row.y,
          zoneId: row.zone_id,
          isPublic: row.is_public,
          appearance: row.appearance || worldState._generateBuildingAppearance(row.owner_wallet || row.owner, row.type),
          createdAt: row.created_at ? parseInt(row.created_at) : Date.now(),
          createdAtTick: row.created_at_tick,
        };

        worldState.buildings.set(building.id, building);

        // Update tile
        const tileKey = `${building.x},${building.y}`;
        const tile = worldState.tiles.get(tileKey);
        if (tile) tile.buildingId = building.id;
      }

      // Load tile claims
      const claimsResult = await this.pool.query('SELECT * FROM tile_claims');
      for (const row of claimsResult.rows) {
        const tileKey = `${row.x},${row.y}`;
        const tile = worldState.tiles.get(tileKey);
        if (tile) {
          tile.owner = row.owner;
          tile.claimedAt = row.claimed_at_tick;
        }
      }

      // Load ledger balances
      const ledgerResult = await this.pool.query('SELECT * FROM ledger');
      for (const row of ledgerResult.rows) {
        worldState._initLedger(row.agent_id);
        const account = worldState.ledger.get(row.agent_id);
        if (account) {
          account.balance = parseInt(row.balance);
          account.totalDeposited = parseInt(row.total_deposited);
          account.totalSpent = parseInt(row.total_spent);
          account.totalEarned = parseInt(row.total_earned);
        }
      }

      const agentCount = worldState.agents.size;
      const buildingCount = worldState.buildings.size;
      const zoneCount = worldState.zones.size;

      if (agentCount > 0 || buildingCount > 0) {
        console.log(`[DB] World loaded: tick ${worldState.tick}, ${agentCount} agents, ${buildingCount} buildings, ${zoneCount} zones, ${worldState.protocolRevenue / 1e9} SOL revenue`);
      } else {
        console.log('[DB] Database is empty — starting fresh world');
      }

      return true;
    } catch (err) {
      console.error(`[DB] Load failed: ${err.message}`);
      return false;
    }
  }

  // ==================== AUTO-SAVE ====================

  startAutoSave(worldState) {
    if (!this.enabled) return;

    this.saveTimer = setInterval(() => {
      this.saveWorld(worldState).catch(err => {
        console.error(`[DB] Auto-save error: ${err.message}`);
      });
    }, this.saveInterval);

    console.log(`[DB] Auto-save enabled (every ${this.saveInterval / 1000}s)`);
  }

  stopAutoSave() {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // ==================== SAVE TRANSACTION ====================

  async logTransaction(agentId, type, amount, reason, tick) {
    if (!this.enabled) return;

    try {
      await this.pool.query(
        'INSERT INTO transactions (agent_id, type, amount, reason, tick) VALUES ($1, $2, $3, $4, $5)',
        [agentId, type, amount, reason, tick]
      );
    } catch (err) {
      // Non-critical — don't crash on logging failure
    }
  }

  // ==================== CLEANUP ====================

  async close() {
    this.stopAutoSave();
    if (this.pool) {
      await this.pool.end();
      console.log('[DB] Connection closed');
    }
  }
}

module.exports = { Database };
