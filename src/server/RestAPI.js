/**
 * RestAPI — HTTP endpoints for the operator dashboard, spectators, and external queries.
 * 
 * Uses Node.js built-in http module (no Express needed for MVP).
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

class RestAPI {
  constructor(worldState, connectionManager, options = {}) {
    this.world = worldState;
    this.connections = connectionManager;
    this.port = options.port || 3000;
    this.server = null;

    // SSE connections for real-time spectator updates
    this.sseClients = new Set();

    // Static file cache { filePath -> { content, etag } }
    this._fileCache = new Map();

    // IP-based rate limiting
    this.ipRateLimits = new Map();
    this.ipRateLimitConfig = {
      maxRequests: 100,     // per window
      windowMs: 60000,      // 1 minute
    };

    // Browser wallet auth sessions: wallet -> { verified, verifiedAt }
    this._walletSessions = new Map();
    // Pending challenges for browser wallet auth: challengeId -> { challenge, wallet, createdAt }
    this._walletChallenges = new Map();

    // Wallet→agentId index for fast lookups (avoids linear scans)
    this._walletIndex = new Map(); // wallet -> Set of agentIds
  }

  // Maintain wallet index — call when agents are added/removed
  _indexWallet(wallet, agentId) {
    if (!wallet) return;
    if (!this._walletIndex.has(wallet)) this._walletIndex.set(wallet, new Set());
    this._walletIndex.get(wallet).add(agentId);
  }

  _unindexWallet(wallet, agentId) {
    if (!wallet) return;
    const set = this._walletIndex.get(wallet);
    if (set) { set.delete(agentId); if (set.size === 0) this._walletIndex.delete(wallet); }
  }

  _getAgentsByWallet(wallet) {
    const ids = this._walletIndex.get(wallet);
    if (!ids) return [];
    const agents = [];
    for (const id of ids) {
      const agent = this.world.getAgent(id);
      if (agent) agents.push(agent);
    }
    return agents;
  }

  // Solana base58 wallet address validation
  _isValidSolanaWallet(addr) {
    if (typeof addr !== 'string') return false;
    if (addr.length < 32 || addr.length > 44) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr); // base58 charset
  }

  start() {
    this.server = http.createServer((req, res) => {
      // CORS headers
      const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : null;
      const origin = req.headers.origin;
      if (allowedOrigins) {
        if (allowedOrigins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
        }
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      // IP rate limiting
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
      const now = Date.now();
      if (!this.ipRateLimits.has(clientIp)) {
        this.ipRateLimits.set(clientIp, { count: 1, resetAt: now + this.ipRateLimitConfig.windowMs });
      } else {
        const bucket = this.ipRateLimits.get(clientIp);
        if (now > bucket.resetAt) {
          bucket.count = 1;
          bucket.resetAt = now + this.ipRateLimitConfig.windowMs;
        } else {
          bucket.count++;
          if (bucket.count > this.ipRateLimitConfig.maxRequests) {
            res.setHeader('X-RateLimit-Limit', this.ipRateLimitConfig.maxRequests);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));
            res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
            res.writeHead(429);
            return res.end(JSON.stringify({ error: 'Too many requests' }));
          }
        }
      }

      // Rate limit headers on all responses
      const bucket = this.ipRateLimits.get(clientIp);
      res.setHeader('X-RateLimit-Limit', this.ipRateLimitConfig.maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, this.ipRateLimitConfig.maxRequests - bucket.count));
      res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

      const requestStart = Date.now();
      const parsedUrl = url.parse(req.url, true);
      const path = parsedUrl.pathname;
      const query = parsedUrl.query;

      // Structured request logging
      res.on('finish', () => {
        const duration = Date.now() - requestStart;
        if (path.startsWith('/api/')) {
          const log = {
            ts: new Date().toISOString(),
            method: req.method,
            path,
            status: res.statusCode,
            ms: duration,
            ip: clientIp,
          };
          if (duration > 1000) log.slow = true;
          console.log(`[HTTP] ${JSON.stringify(log)}`);
        }
      });

      try {
        // Route matching
        if (path === '/api/health') return this._health(req, res);
        if (path === '/api/stats') return this._stats(req, res);
        if (path === '/api/agents') return this._agents(req, res, query);
        if (path.startsWith('/api/agent/')) return this._agent(req, res, path);
        if (path === '/api/zones') return this._zones(req, res);
        if (path === '/api/buildings') return this._buildings(req, res);
        if (path === '/api/events') return this._sseEvents(req, res);

        // Operator dashboard endpoints
        if (path.startsWith('/api/operator/')) return this._operator(req, res, path, query);

        // P&L snapshots
        if (path === '/api/snapshots') return this._snapshots(req, res, query);

        // Webhook configuration
        if (path === '/api/webhooks' && req.method === 'POST') return this._setWebhook(req, res);
        if (path === '/api/webhooks' && req.method === 'GET') return this._getWebhooks(req, res, query);
        if (path === '/api/webhooks/test') return this._testWebhook(req, res, query);

        // Chat history
        if (path === '/api/chat/history') return this._chatHistory(req, res, query);

        // Metrics
        if (path === '/api/metrics') return this._metrics(req, res);

        // Admin endpoints
        if (path === '/api/admin/reset' && req.method === 'POST') return this._adminReset(req, res);
        if (path === '/api/admin/cleanup' && req.method === 'POST') return this._adminCleanup(req, res);

        // Social graph
        if (path === '/api/social-graph') return this._socialGraph(req, res, query);

        // Bridge endpoints
        if (path === '/api/bridges') return this._bridgeList(req, res);
        if (path === '/api/bridges/stats') return this._bridgeStats(req, res);
        if (path.startsWith('/api/bridges/transactions/')) return this._bridgeTransactions(req, res, path);

        // Economy endpoints
        if (path === '/api/economy') return this._economy(req, res);
        if (path === '/api/economy/revenue') return this._economyRevenue(req, res);
        if (path.startsWith('/api/economy/balance/')) return this._economyBalance(req, res, path);
        if (path.startsWith('/api/economy/history/')) return this._economyHistory(req, res, path);

        // Bounty endpoints
        if (path === '/api/bounties' && req.method === 'POST') return this._postBountyREST(req, res);
        if (path === '/api/bounties') return this._bounties(req, res, query);
        if (path === '/api/bounties/stats') return this._bountyStats(req, res);
        if (path.startsWith('/api/bounties/')) return this._bountyDetail(req, res, path);

        // OpenAPI spec
        if (path === '/api/openapi.json') return this._serveFile(res, req, 'docs/openapi.json', 'application/json');

        // Marketplace endpoints
        if (path === '/api/marketplace') return this._marketplace(req, res, query);

        // Crafting endpoints
        if (path === '/api/crafting/recipes') return this._craftingRecipes(req, res);

        // World events endpoint
        if (path === '/api/world/events') return this._worldEvents(req, res);

        // Guild detail endpoint
        if (path.startsWith('/api/guilds/')) return this._guildDetail(req, res, path);
        if (path === '/api/guilds') return this._guildsList(req, res);

        // Browser wallet auth (optional real-wallet identity)
        if (path === '/api/auth/challenge' && req.method === 'POST') return this._authChallenge(req, res);
        if (path === '/api/auth/verify' && req.method === 'POST') return this._authVerify(req, res);

        // Static file serving for viewer, dashboard, landing
        if (path === '/' || path === '/index.html') return this._serveFile(res, req, 'landing/index.html', 'text/html');
        if (path === '/viewer' || path === '/viewer/') return this._serveFile(res, req, 'viewer/index.html', 'text/html');
        if (path === '/play' || path === '/play/') return this._serveFile(res, req, 'viewer/index.html', 'text/html');
        if (path === '/dashboard' || path === '/dashboard/') return this._serveFile(res, req, 'dashboard/index.html', 'text/html');
        if (path === '/bounties' || path === '/bounties/') return this._serveFile(res, req, 'bounties/index.html', 'text/html');
        if (path === '/chat' || path === '/chat/') return this._serveFile(res, req, 'chat/index.html', 'text/html');
        if (path === '/tools/assets' || path === '/tools/assets/') return this._serveFile(res, req, 'tools/asset-generator.html', 'text/html');
        if (path === '/docs' || path === '/docs/') return this._serveFile(res, req, 'docs/index.html', 'text/html');
        if (path === '/leaderboard' || path === '/leaderboard/') return this._serveFile(res, req, 'leaderboard/index.html', 'text/html');
        if (path === '/profiles' || path === '/profiles/') return this._serveFile(res, req, 'profiles/index.html', 'text/html');

        // Serve asset files (sprites, tilesets, effects)
        if (path.startsWith('/assets/')) return this._serveAsset(res, path);

        // 404
        this._json(res, 404, { error: 'Not found' });
      } catch (err) {
        console.error(`[REST] Error on ${path}:`, err.message);
        this._json(res, 500, { error: 'Internal server error' });
      }
    });

    this.server.listen(this.port, () => {
      console.log(`[REST] API server listening on port ${this.port}`);
    });

    return this.server;
  }

  // Parse request body with size limit (1MB default)
  _parseBody(req, res, callback, maxSize = 1048576) {
    let body = '';
    let exceeded = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxSize) {
        exceeded = true;
        req.destroy();
        this._json(res, 413, { error: 'Request body too large' });
      }
    });
    req.on('end', () => {
      if (exceeded) return;
      try {
        const data = JSON.parse(body);
        callback(data);
      } catch (e) {
        this._json(res, 400, { error: 'Invalid JSON body' });
      }
    });
  }

  // ==================== ENDPOINTS ====================

  async _health(req, res) {
    const health = {
      status: 'ok',
      tick: this.world.tick,
      uptime: Date.now() - this.world.startedAt,
      agents: this.world.agents.size,
      db: 'disabled',
    };

    // Deep health check — verify DB connection
    if (this.db && this.db.enabled && this.db.pool) {
      try {
        const start = Date.now();
        await this.db.pool.query('SELECT 1');
        health.db = 'connected';
        health.dbLatencyMs = Date.now() - start;
      } catch (err) {
        health.status = 'degraded';
        health.db = 'disconnected';
        health.dbError = err.message;
      }
    }

    const statusCode = health.status === 'ok' ? 200 : 503;
    this._json(res, statusCode, health);
  }

  _stats(req, res) {
    const worldStats = this.world.getWorldStats();
    const connStats = this.connections.getStats();

    this._json(res, 200, {
      world: worldStats,
      connections: connStats,
    });
  }

  _agents(req, res, query = {}) {
    const limit = Math.min(parseInt(query.limit) || 50, 200);
    const offset = Math.max(0, parseInt(query.offset) || 0);
    const walletFilter = query.wallet;

    // Use wallet index for filtered queries, iterate-with-skip for general queries
    let source;
    if (walletFilter) {
      source = this._getAgentsByWallet(walletFilter);
    } else {
      source = this.world.agents.values();
    }

    const agents = [];
    let total = 0;
    let skipped = 0;
    for (const a of source) {
      total++;
      if (skipped < offset) { skipped++; continue; }
      if (agents.length >= limit) continue; // still counting total
      agents.push({
        id: a.id,
        name: a.name,
        x: a.x,
        y: a.y,
        status: a.status,
        level: a.level || 1,
        xp: a.xp || 0,
        guildId: a.guildId || null,
        reputation: a.reputation,
        connectedAt: a.connectedAt,
      });
    }

    this._json(res, 200, { agents, total, offset, limit });
  }

  _agent(req, res, path) {
    const agentId = path.replace('/api/agent/', '').split('/')[0];
    const subPath = path.replace(`/api/agent/${agentId}`, '') || '/';
    const agent = this.world.getAgent(agentId);

    if (!agent) {
      return this._json(res, 404, { error: 'Agent not found' });
    }

    if (subPath === '/' || subPath === '') {
      return this._json(res, 200, {
        id: agent.id,
        name: agent.name,
        x: agent.x,
        y: agent.y,
        wallet: agent.wallet,
        status: agent.status,
        xp: agent.xp || 0,
        level: agent.level || 1,
        nextLevelXp: (agent.level || 1) * 100,
        combat: agent.combat ? {
          hp: agent.combat.hp,
          maxHp: agent.combat.maxHp,
          attack: agent.combat.attack,
          defense: agent.combat.defense,
          kills: agent.combat.kills,
          deaths: agent.combat.deaths,
        } : null,
        inventory: agent.metadata?.inventory || {},
        guildId: agent.guildId || null,
        guildRole: agent.guildRole || null,
        reputation: agent.reputation,
        connectedAt: agent.connectedAt,
      });
    }

    if (subPath === '/observation') {
      const observation = this.world.getObservation(agentId);
      return this._json(res, 200, observation);
    }

    if (subPath === '/buildings') {
      const buildings = [...this.world.buildings.values()]
        .filter(b => b.owner === agentId)
        .map(b => ({
          id: b.id,
          type: b.type,
          name: b.name,
          x: b.x,
          y: b.y,
          createdAt: b.createdAt,
        }));
      return this._json(res, 200, { buildings, count: buildings.length });
    }

    this._json(res, 404, { error: 'Endpoint not found' });
  }

  _zones(req, res) {
    const zones = [...this.world.zones.values()].map(z => ({
      id: z.id,
      name: z.name,
      biome: z.biome,
      originX: z.originX,
      originY: z.originY,
      width: z.width,
      height: z.height,
      agentCount: z.agentCount,
      createdAt: z.createdAt,
    }));

    this._json(res, 200, { zones, count: zones.length });
  }

  _buildings(req, res) {
    const buildings = [...this.world.buildings.values()].map(b => ({
      id: b.id,
      type: b.type,
      name: b.name,
      owner: b.owner,
      x: b.x,
      y: b.y,
      isPublic: b.isPublic,
      createdAt: b.createdAt,
    }));

    this._json(res, 200, { buildings, count: buildings.length });
  }

  // ==================== SSE (Server-Sent Events) ====================

  _sseEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial state
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      tick: this.world.tick,
      stats: this.world.getWorldStats(),
    })}\n\n`);

    this.sseClients.add(res);

    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  // Call this from the tick engine to broadcast events via SSE
  broadcastSSE(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (err) {
        this.sseClients.delete(client);
      }
    }
  }

  // ==================== OPERATOR DASHBOARD ====================

  _operator(req, res, path, query) {
    // Operator endpoints require wallet auth
    // Supports signed timestamp: ?wallet=X&timestamp=T&signature=HMAC(wallet:timestamp, OPERATOR_SECRET)
    // Falls back to plain wallet param if OPERATOR_SECRET is not set
    const wallet = query.wallet;
    if (!wallet) {
      return this._json(res, 401, { error: 'Missing wallet parameter' });
    }

    if (process.env.OPERATOR_SECRET) {
      const { timestamp, signature } = query;
      if (!timestamp || !signature) {
        return this._json(res, 401, { error: 'Missing timestamp or signature. Sign with HMAC-SHA256(wallet:timestamp, OPERATOR_SECRET).' });
      }
      // Reject if timestamp is older than 5 minutes
      const age = Date.now() - parseInt(timestamp);
      if (isNaN(age) || age > 300000 || age < -30000) {
        return this._json(res, 401, { error: 'Timestamp expired or invalid' });
      }
      const crypto = require('crypto');
      const expected = crypto.createHmac('sha256', process.env.OPERATOR_SECRET).update(`${wallet}:${timestamp}`).digest('hex');
      if (signature !== expected) {
        return this._json(res, 403, { error: 'Invalid signature' });
      }
    }

    // Find agents owned by this wallet (uses indexed lookup)
    const ownedAgents = this._getAgentsByWallet(wallet);

    const subPath = path.replace('/api/operator/', '');

    if (subPath === 'agents') {
      return this._json(res, 200, {
        agents: ownedAgents.map(a => ({
          id: a.id,
          name: a.name,
          x: a.x,
          y: a.y,
          status: a.status,
          reputation: a.reputation,
          controls: a.controls,
          connectedAt: a.connectedAt,
        })),
        count: ownedAgents.length,
      });
    }

    if (subPath === 'dashboard') {
      // Full dashboard data for all owned agents
      const dashboard = ownedAgents.map(agent => {
        const observation = this.world.getObservation(agent.id);
        const buildings = [...this.world.buildings.values()].filter(b => b.owner === agent.id);

        return {
          agent: {
            id: agent.id,
            name: agent.name,
            x: agent.x,
            y: agent.y,
            wallet: agent.wallet,
            status: agent.status,
            reputation: agent.reputation,
            controls: agent.controls,
          },
          observation,
          buildings: buildings.map(b => ({
            id: b.id,
            type: b.type,
            name: b.name,
            x: b.x,
            y: b.y,
          })),
        };
      });

      return this._json(res, 200, {
        dashboard,
        worldStats: this.world.getWorldStats(),
      });
    }

    // Operator controls — POST endpoint
    if (subPath.startsWith('control/') && req.method === 'POST') {
      return this._handleOperatorControl(req, res, subPath, wallet);
    }

    this._json(res, 404, { error: 'Operator endpoint not found' });
  }

  _handleOperatorControl(req, res, subPath, wallet) {
    this._parseBody(req, res, (data) => {
        const parts = subPath.split('/');
        const agentId = parts[1];
        const controlAction = parts[2];

        const agent = this.world.getAgent(agentId);
        if (!agent) {
          return this._json(res, 404, { error: 'Agent not found' });
        }
        if (agent.wallet !== wallet) {
          return this._json(res, 403, { error: 'Not your agent' });
        }

        switch (controlAction) {
          case 'pause':
            agent.controls.paused = true;
            agent.status = 'paused';
            return this._json(res, 200, { success: true, status: 'paused' });

          case 'resume':
            agent.controls.paused = false;
            agent.status = 'active';
            return this._json(res, 200, { success: true, status: 'active' });

          case 'set-limits':
            if (data.maxSpendPerTick !== undefined) agent.controls.maxSpendPerTick = data.maxSpendPerTick;
            if (data.zoneBlacklist) agent.controls.zoneBlacklist = data.zoneBlacklist;
            if (data.agentBlacklist) agent.controls.agentBlacklist = data.agentBlacklist;
            if (data.allowedActions) agent.controls.allowedActions = data.allowedActions;
            return this._json(res, 200, { success: true, controls: agent.controls });

          case 'kill':
            this.world.removeAgent(agentId);
            this.connections.clients.delete(agentId);
            return this._json(res, 200, { success: true, status: 'killed' });

          case 'withdraw': {
            const amount = data.amount || data.amountSOL ? Math.floor(data.amountSOL * 1e9) : 0;
            if (amount <= 0) return this._json(res, 400, { error: 'Invalid amount' });
            const balance = this.world.getBalance(agentId);
            if (balance.balance < amount) {
              return this._json(res, 400, { error: `Insufficient balance: have ${balance.balanceSOL} SOL, need ${amount / 1e9} SOL` });
            }
            const result = this.world.spend(agentId, amount, `operator withdrawal to ${wallet}`);
            if (result.success) {
              return this._json(res, 200, {
                success: true,
                withdrawn: amount,
                withdrawnSOL: amount / 1e9,
                remainingBalance: this.world.getBalance(agentId).balance,
                remainingBalanceSOL: this.world.getBalance(agentId).balanceSOL,
                note: 'In production (DRY_RUN=false), this triggers an on-chain SOL transfer to your wallet.',
              });
            }
            return this._json(res, 400, { error: result.error });
          }

          default:
            return this._json(res, 400, { error: `Unknown control action: ${controlAction}` });
        }
    });
  }

  // ==================== ECONOMY ENDPOINTS ====================

  _economy(req, res) {
    const revenue = this.world.getProtocolRevenue();
    const totalAgentBalances = [...this.world.ledger.values()].reduce((sum, a) => sum + a.balance, 0);

    this._json(res, 200, {
      protocolRevenue: revenue,
      totalAgentBalances,
      totalAgentBalancesSOL: totalAgentBalances / 1e9,
      costs: {
        landClaim: '0.01 SOL per tile',
        buildings: {
          home: '0.1 SOL',
          shop: '0.25 SOL',
          vault: '0.5 SOL',
          lab: '0.5 SOL',
          headquarters: '1.0 SOL',
        },
        upgrades: {
          level2: '0.2 SOL',
          level3: '0.5 SOL',
        },
        landSaleFee: '2% protocol fee',
      },
      claimedTiles: [...this.world.tiles.values()].filter(t => t.owner).length,
      totalTiles: this.world.tiles.size,
    });
  }

  _economyRevenue(req, res) {
    this._json(res, 200, this.world.getProtocolRevenue());
  }

  _economyBalance(req, res, path) {
    const agentId = path.replace('/api/economy/balance/', '');
    const agent = this.world.getAgent(agentId);
    if (!agent) return this._json(res, 404, { error: 'Agent not found' });

    const balance = this.world.getBalance(agentId);
    const ownedTiles = [...this.world.tiles.values()].filter(t => t.owner === agentId).length;
    const ownedBuildings = [...this.world.buildings.values()].filter(b => b.owner === agentId);

    this._json(res, 200, {
      agent: { id: agent.id, name: agent.name },
      ...balance,
      ownedTiles,
      ownedBuildings: ownedBuildings.length,
      assets: ownedBuildings.map(b => ({
        id: b.id,
        type: b.type,
        level: b.appearance.level,
        location: `(${b.x}, ${b.y})`,
      })),
    });
  }

  _economyHistory(req, res, path) {
    const agentId = path.replace('/api/economy/history/', '');
    const history = this.world.getTransactionHistory(agentId, 100);
    this._json(res, 200, { agentId, history, count: history.length });
  }

  // ==================== BOUNTY ENDPOINTS ====================

  // ==================== P&L SNAPSHOTS ====================

  async _snapshots(req, res, query) {
    const limit = Math.min(parseInt(query.limit) || 100, 500);

    // If DB is available, query real snapshots
    if (this.db && this.db.enabled) {
      try {
        const result = await this.db.pool.query(
          'SELECT * FROM snapshots ORDER BY tick DESC LIMIT $1', [limit]
        );
        return this._json(res, 200, {
          snapshots: result.rows.map(r => ({
            tick: r.tick,
            timestamp: r.timestamp,
            agentCount: r.agent_count,
            zoneCount: r.zone_count,
            buildingCount: r.building_count,
            totalBalances: parseInt(r.total_balances),
            totalBalancesSOL: parseInt(r.total_balances) / 1e9,
            protocolRevenue: parseInt(r.protocol_revenue),
            protocolRevenueSOL: parseInt(r.protocol_revenue) / 1e9,
            totalTrades: r.total_trades,
            totalBounties: r.total_bounties,
            totalResourcesGathered: r.total_resources_gathered,
            guildCount: r.guild_count,
          })).reverse(),
          count: result.rows.length,
        });
      } catch (e) {
        // Fall through to in-memory
      }
    }

    // In-memory fallback — return current snapshot only
    const totalBalances = [...this.world.ledger.values()].reduce((s, a) => s + a.balance, 0);
    return this._json(res, 200, {
      snapshots: [{
        tick: this.world.tick,
        timestamp: new Date().toISOString(),
        agentCount: this.world.agents.size,
        zoneCount: this.world.zones.size,
        buildingCount: this.world.buildings.size,
        totalBalancesSOL: totalBalances / 1e9,
        protocolRevenueSOL: this.world.protocolRevenue / 1e9,
      }],
      count: 1,
      note: 'No database — showing current snapshot only',
    });
  }

  // ==================== WEBHOOKS / ALERTS ====================

  _setWebhook(req, res) {
    this._parseBody(req, res, (data) => {
        const { wallet, url, events, channel } = data;

        if (!wallet) return this._json(res, 400, { error: 'Missing wallet' });
        if (!url && !channel) return this._json(res, 400, { error: 'Missing url or channel (telegram/discord)' });

        // Validate webhook URL to prevent SSRF
        if (url) {
          try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              return this._json(res, 400, { error: 'Webhook URL must use http or https' });
            }
            // Block private/internal IPs
            const host = parsed.hostname;
            if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' ||
                host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.') ||
                host.endsWith('.local') || host.endsWith('.internal')) {
              return this._json(res, 400, { error: 'Webhook URL cannot point to private/internal addresses' });
            }
          } catch (e) {
            return this._json(res, 400, { error: 'Invalid webhook URL' });
          }
        }

        // Store webhook config
        if (!this._webhooks) this._webhooks = new Map();

        const hookId = require('crypto').randomUUID ? require('crypto').randomUUID() : Date.now().toString();
        this._webhooks.set(hookId, {
          id: hookId,
          wallet,
          url: url || null,
          channel: channel || null, // 'telegram:chatId' or 'discord:webhookUrl'
          events: events || ['agent_defeated', 'bounty_completed', 'trade_proposed', 'territory_captured', 'guild_created'],
          createdAt: Date.now(),
          deliveries: 0,
          lastDelivery: null,
          active: true,
        });

        this._json(res, 201, {
          success: true,
          webhookId: hookId,
          events: events || ['agent_defeated', 'bounty_completed', 'trade_proposed', 'territory_captured', 'guild_created'],
          note: 'Webhook registered. Events will be delivered via HTTP POST.',
        });
    });
  }

  _getWebhooks(req, res, query) {
    const wallet = query.wallet;
    if (!wallet) return this._json(res, 400, { error: 'Missing wallet param' });

    const hooks = [];
    if (this._webhooks) {
      for (const [, hook] of this._webhooks) {
        if (hook.wallet === wallet) {
          hooks.push({
            id: hook.id,
            url: hook.url,
            channel: hook.channel,
            events: hook.events,
            deliveries: hook.deliveries,
            lastDelivery: hook.lastDelivery,
            active: hook.active,
            consecutiveFailures: hook.consecutiveFailures || 0,
            lastError: hook.lastError || null,
          });
        }
      }
    }

    this._json(res, 200, { webhooks: hooks, count: hooks.length });
  }

  _testWebhook(req, res, query) {
    const wallet = query.wallet;
    if (!wallet) return this._json(res, 400, { error: 'Missing wallet param' });

    // Fire a test event to all webhooks for this wallet
    const testEvent = {
      type: 'test',
      message: 'This is a test alert from Agent World Protocol',
      tick: this.world.tick,
      timestamp: new Date().toISOString(),
    };

    let delivered = 0;
    if (this._webhooks) {
      for (const [, hook] of this._webhooks) {
        if (hook.wallet === wallet && hook.active && hook.url) {
          this._deliverWebhook(hook, testEvent);
          delivered++;
        }
      }
    }

    this._json(res, 200, { success: true, delivered, event: testEvent });
  }

  async _deliverWebhook(hook, event, retries = 2) {
    if (!hook.url) return;
    try {
      const https = require('https');
      const http = require('http');
      const urlObj = new URL(hook.url);
      const lib = urlObj.protocol === 'https:' ? https : http;

      const postData = JSON.stringify({ event, hookId: hook.id, timestamp: new Date().toISOString() });

      await new Promise((resolve, reject) => {
        const req = lib.request({
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          timeout: 5000,
        }, (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(postData);
        req.end();
      });

      hook.deliveries++;
      hook.lastDelivery = Date.now();
      hook.consecutiveFailures = 0;
    } catch (e) {
      hook.consecutiveFailures = (hook.consecutiveFailures || 0) + 1;
      hook.lastError = e.message;
      hook.lastErrorAt = Date.now();

      // Retry with backoff
      if (retries > 0) {
        setTimeout(() => this._deliverWebhook(hook, event, retries - 1), 2000 * (3 - retries));
      } else if (hook.consecutiveFailures >= 10) {
        hook.active = false;
        console.log(`[Webhook] Disabled hook ${hook.id} after ${hook.consecutiveFailures} consecutive failures`);
      }
    }
  }

  // Broadcast events to matching webhooks (called from tick)
  _broadcastWebhookEvents(events) {
    if (!this._webhooks || this._webhooks.size === 0) return;

    for (const event of events) {
      for (const [, hook] of this._webhooks) {
        if (hook.active && hook.events.includes(event.type) && hook.url) {
          this._deliverWebhook(hook, event).catch(() => { /* errors handled inside _deliverWebhook */ });
        }
      }
    }
  }

  // ==================== SOCIAL GRAPH ====================

  _socialGraph(req, res, query) {
    const nodes = [];
    const edges = [];

    // Agents as nodes
    for (const [agentId, agent] of this.world.agents) {
      nodes.push({
        id: agentId,
        name: agent.name,
        type: 'agent',
        guildId: agent.guildId,
        rating: agent.reputation.averageRating,
        trades: agent.reputation.tradesCompleted,
        x: agent.x,
        y: agent.y,
      });
    }

    // Guilds as nodes
    if (this.world.guilds) {
      for (const [guildId, guild] of this.world.guilds) {
        nodes.push({
          id: guildId,
          name: guild.name,
          type: 'guild',
          memberCount: guild.members.length,
          treasury: guild.treasury,
        });

        // Guild membership edges
        for (const member of guild.members) {
          edges.push({
            from: member.agentId,
            to: guildId,
            type: 'member',
            role: member.role,
          });
        }
      }
    }

    // Rating edges
    if (this.world.ratings) {
      for (const [, rating] of this.world.ratings) {
        edges.push({
          from: rating.fromId,
          to: rating.toId,
          type: 'rating',
          score: rating.score,
        });
      }
    }

    // Trade edges (from transaction log)
    const tradePairs = new Map();
    for (const tx of this.world.transactionLog || []) {
      if (tx.type === 'trade') {
        const key = [tx.fromId, tx.toId].sort().join(':');
        if (!tradePairs.has(key)) {
          tradePairs.set(key, { from: tx.fromId, to: tx.toId, count: 0, volume: 0 });
        }
        const pair = tradePairs.get(key);
        pair.count++;
        pair.volume += tx.amount || 0;
      }
    }
    for (const [, pair] of tradePairs) {
      edges.push({ from: pair.from, to: pair.to, type: 'trade', count: pair.count, volume: pair.volume });
    }

    this._json(res, 200, {
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    });
  }

  _postBountyREST(req, res) {
    this._parseBody(req, res, (data) => {
        const { wallet, title, description, rewardSOL, deadline, tags, minReputation } = data;

        if (!wallet) return this._json(res, 400, { error: 'Missing wallet address' });
        if (!title) return this._json(res, 400, { error: 'Missing title' });
        if (!description) return this._json(res, 400, { error: 'Missing description' });
        if (!rewardSOL || rewardSOL <= 0) return this._json(res, 400, { error: 'Missing or invalid rewardSOL' });

        // Find or create a virtual agent for this wallet
        let agent = null;
        for (const [, a] of this.world.agents) {
          if (a.wallet === wallet) { agent = a; break; }
        }

        if (!agent) {
          // Create a temporary agent for the bounty poster
          agent = this.world.addAgent({ wallet, name: `Bounty-${wallet.slice(0, 6)}` });
        }

        // Check balance
        const balance = this.world.getBalance(agent.id);
        const rewardLamports = Math.floor(rewardSOL * 1e9);
        if (balance.balance < rewardLamports) {
          return this._json(res, 400, {
            error: `Insufficient balance: have ${balance.balanceSOL} SOL, need ${rewardSOL} SOL`,
            balance: balance.balanceSOL,
            agentId: agent.id,
            note: 'Deposit SOL first using the deposit action.',
          });
        }

        // Queue the bounty action
        const action = {
          type: 'post_bounty',
          title, description,
          rewardSOL,
          deadline: deadline || 3000,
          tags: tags || [],
          minReputation: minReputation || 0,
        };

        this.world.queueAction(agent.id, action);
        const tickResult = this.world.processTick();
        const result = tickResult.results[0];

        if (result && result.success) {
          this._json(res, 201, {
            success: true,
            bounty: result.data,
            agentId: agent.id,
            wallet,
          });
        } else {
          this._json(res, 400, { success: false, error: result ? result.error : 'Failed to post bounty' });
        }
    });
  }

  _bounties(req, res, query) {
    const status = query.status || 'open';
    const tag = query.tag || null;
    const limit = Math.min(parseInt(query.limit) || 50, 100);
    const offset = parseInt(query.offset) || 0;

    let results = [...this.world.bounties.values()];

    if (status !== 'all') {
      results = results.filter(b => b.status === status);
    }
    if (tag) {
      results = results.filter(b => b.tags.includes(tag));
    }

    results.sort((a, b) => b.reward - a.reward);
    const total = results.length;
    results = results.slice(offset, offset + limit);

    this._json(res, 200, {
      bounties: results.map(b => ({
        id: b.id,
        title: b.title,
        description: b.description.slice(0, 300),
        reward: b.reward,
        rewardSOL: b.reward / 1e9,
        status: b.status,
        creatorId: b.creatorId,
        creatorName: b.creatorName,
        tags: b.tags,
        minReputation: b.minReputation,
        deadline: b.deadline,
        ticksRemaining: Math.max(0, b.deadline - this.world.tick),
        claimedBy: b.claimedBy,
        createdAt: b.createdAt,
      })),
      count: results.length,
      total,
      offset,
      limit,
      totalBounties: this.world.bounties.size,
    });
  }

  _bountyStats(req, res) {
    const all = [...this.world.bounties.values()];
    const open = all.filter(b => b.status === 'open').length;
    const claimed = all.filter(b => b.status === 'claimed').length;
    const submitted = all.filter(b => b.status === 'submitted').length;
    const completed = all.filter(b => b.status === 'completed').length;
    const expired = all.filter(b => b.status === 'expired').length;
    const totalRewardPool = all.filter(b => b.status === 'open' || b.status === 'claimed' || b.status === 'submitted')
      .reduce((sum, b) => sum + b.reward, 0);

    this._json(res, 200, {
      total: all.length,
      open,
      claimed,
      submitted,
      completed,
      expired,
      totalRewardPool,
      totalRewardPoolSOL: totalRewardPool / 1e9,
    });
  }

  _bountyDetail(req, res, path) {
    const bountyId = path.replace('/api/bounties/', '');
    const bounty = this.world.bounties.get(bountyId);
    if (!bounty) return this._json(res, 404, { error: 'Bounty not found' });

    this._json(res, 200, {
      ...bounty,
      rewardSOL: bounty.reward / 1e9,
      ticksRemaining: Math.max(0, bounty.deadline - this.world.tick),
    });
  }

  // ==================== BRIDGE ENDPOINTS ====================

  _bridgeList(req, res) {
    if (!this.bridgeManager) {
      return this._json(res, 200, { bridges: [], note: 'No bridges configured' });
    }

    const bridges = [...this.bridgeManager.bridges.keys()].map(name => ({
      name,
      status: 'active',
    }));

    this._json(res, 200, {
      bridges,
      usage: {
        note: 'Agents use bridges via the "bridge" action in the WebSocket protocol.',
        example: '{ type: "action", action: { type: "bridge", bridge: "jupiter", bridgeAction: "quote", params: { inputToken: "SOL", outputToken: "USDC", amount: 1000000000 } } }',
      },
    });
  }

  _bridgeStats(req, res) {
    if (!this.bridgeManager) {
      return this._json(res, 200, { stats: {} });
    }
    this._json(res, 200, { stats: this.bridgeManager.getStats() });
  }

  _bridgeTransactions(req, res, path) {
    if (!this.bridgeManager) {
      return this._json(res, 200, { transactions: [] });
    }

    const agentId = path.replace('/api/bridges/transactions/', '');
    const transactions = this.bridgeManager.getAgentTransactions(agentId);
    this._json(res, 200, { agentId, transactions, count: transactions.length });
  }

  // ==================== CHAT HISTORY ====================

  async _chatHistory(req, res, query) {
    const channel = query.channel || 'world';
    const limit = Math.min(parseInt(query.limit) || 50, 200);
    const offset = parseInt(query.offset) || 0;

    if (this.db && this.db.enabled) {
      const messages = await this.db.getChatHistory(channel, limit + offset);
      const sliced = messages.slice(offset, offset + limit);
      return this._json(res, 200, { messages: sliced, count: sliced.length, channel, offset, limit });
    }

    this._json(res, 200, { messages: [], count: 0, note: 'No database — chat history not available' });
  }

  // ==================== METRICS ====================

  _metrics(req, res) {
    const worldStats = this.world.getWorldStats();
    const connStats = this.connections.getStats();
    const now = Date.now();

    const metrics = {
      timestamp: new Date().toISOString(),
      uptime: now - this.world.startedAt,
      uptimeSeconds: Math.floor((now - this.world.startedAt) / 1000),
      tick: this.world.tick,
      agents: {
        total: this.world.agents.size,
        connected: connStats.agents,
        idle: [...this.world.agents.values()].filter(a => a.status === 'idle').length,
        active: [...this.world.agents.values()].filter(a => a.status === 'active').length,
      },
      world: {
        zones: this.world.zones.size,
        buildings: this.world.buildings.size,
        tiles: this.world.tiles.size,
        claimedTiles: [...this.world.tiles.values()].filter(t => t.owner).length,
        guilds: this.world.guilds ? this.world.guilds.size : 0,
        pendingTrades: this.world.pendingTrades.size,
        activeBounties: [...this.world.bounties.values()].filter(b => b.status === 'open' || b.status === 'claimed').length,
        resources: this.world.resources.size,
      },
      economy: {
        protocolRevenue: this.world.protocolRevenue,
        protocolRevenueSOL: this.world.protocolRevenue / 1e9,
        totalBalances: [...this.world.ledger.values()].reduce((s, a) => s + a.balance, 0),
        transactionLogSize: this.world.transactionLog ? this.world.transactionLog.length : 0,
      },
      connections: connStats,
      spectators: connStats.spectators,
      sseClients: this.sseClients.size,
      webhooks: this._webhooks ? this._webhooks.size : 0,
    };

    this._json(res, 200, metrics);
  }

  // ==================== MARKETPLACE ====================

  _marketplace(req, res, query) {
    const filter = query.item;
    const limit = Math.min(parseInt(query.limit) || 50, 200);
    const offset = parseInt(query.offset) || 0;

    const orders = [];
    for (const [, order] of this.world.marketplace) {
      if (this.world.tick > order.expiresAt) continue;
      if (filter && order.item !== filter) continue;
      orders.push({
        id: order.id, type: order.type, item: order.item,
        quantity: order.quantity, pricePerUnit: order.pricePerUnit,
        seller: order.agentName, sellerId: order.agentId,
        expiresIn: order.expiresAt - this.world.tick,
        createdAt: order.createdAt,
      });
    }
    orders.sort((a, b) => a.pricePerUnit - b.pricePerUnit);

    this._json(res, 200, {
      orders: orders.slice(offset, offset + limit),
      total: orders.length,
      offset,
      limit,
    });
  }

  // ==================== CRAFTING ====================

  _craftingRecipes(req, res) {
    const { CRAFTING_RECIPES } = require('./WorldState');
    const recipes = {};
    for (const [name, def] of Object.entries(CRAFTING_RECIPES)) {
      recipes[name] = {
        ingredients: def.ingredients,
        xp: def.xp,
      };
    }
    this._json(res, 200, { recipes, count: Object.keys(recipes).length });
  }

  // ==================== WORLD EVENTS ====================

  _worldEvents(req, res) {
    const activeEvent = this.world._activeWorldEvent;
    this._json(res, 200, {
      active: activeEvent ? {
        type: activeEvent.type,
        label: activeEvent.label,
        description: activeEvent.desc,
        startTick: activeEvent.startTick,
        endTick: activeEvent.endTick,
        ticksRemaining: activeEvent.endTick - this.world.tick,
      } : null,
      currentTick: this.world.tick,
    });
  }

  // ==================== GUILDS ====================

  _guildsList(req, res) {
    const guilds = [];
    for (const [id, guild] of this.world.guilds) {
      guilds.push({
        id, name: guild.name, tag: guild.tag,
        memberCount: guild.members.length,
        leaderId: guild.leaderId,
        treasurySOL: guild.treasury / 1e9,
        createdAt: guild.createdAt,
      });
    }
    guilds.sort((a, b) => b.memberCount - a.memberCount);
    this._json(res, 200, { guilds, count: guilds.length });
  }

  _guildDetail(req, res, reqPath) {
    const guildId = reqPath.replace('/api/guilds/', '');
    const guild = this.world.guilds.get(guildId);
    if (!guild) return this._json(res, 404, { error: 'Guild not found' });

    const members = guild.members.map(m => {
      const agent = this.world.agents.get(m.agentId);
      return {
        agentId: m.agentId,
        name: agent ? agent.name : 'Unknown',
        role: m.role,
        level: agent ? agent.level : 1,
      };
    });

    // Active wars
    const wars = [];
    for (const [, war] of this.world.wars) {
      if (war.status !== 'active') continue;
      if (war.attackerGuildId === guildId || war.defenderGuildId === guildId) {
        wars.push({
          warId: war.id,
          attacker: war.attackerGuildName,
          defender: war.defenderGuildName,
          attackerScore: war.attackerScore,
          defenderScore: war.defenderScore,
          ticksRemaining: war.endTick - this.world.tick,
        });
      }
    }

    this._json(res, 200, {
      id: guildId,
      name: guild.name,
      tag: guild.tag,
      description: guild.description,
      leaderId: guild.leaderId,
      treasurySOL: guild.treasury / 1e9,
      members,
      memberCount: members.length,
      activeWars: wars,
      createdAt: guild.createdAt,
    });
  }

  // ==================== ADMIN ====================

  _adminReset(req, res) {
    this._parseBody(req, res, (data) => {
        const adminKey = data.adminKey;

        if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
          return this._json(res, 403, { error: 'Invalid or missing admin key. Set ADMIN_KEY env var.' });
        }

        // Clear world state
        this.world.agents.clear();
        this.world.buildings.clear();
        this.world.pendingTrades.clear();
        this.world.bounties.clear();
        this.world.ratings.clear();
        this.world.guilds.clear();
        this.world.contests.clear();
        this.world.ledger.clear();
        this.world.transactionLog = [];
        this.world.protocolRevenue = 0;
        this.world.tick = 0;
        this.world._agentGrid.clear();

        // Clear tiles and re-init zones
        this.world.tiles.clear();
        this.world.zones.clear();
        this.world.resources.clear();
        this.world._initStartingZones();

        // Clear DB tables
        if (this.db && this.db.enabled) {
          this.db.pool.query('TRUNCATE agents, buildings, zones, tile_claims, ledger, transactions, world_meta, snapshots, pending_trades, bounties, chat_messages CASCADE')
            .catch(err => console.error('[Admin] DB truncate failed:', err.message));
        }

        // Disconnect all agents
        for (const [, client] of this.connections.clients) {
          if (client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({ type: 'disconnected', reason: 'World reset by admin' }));
            client.ws.close();
          }
        }
        this.connections.clients.clear();

        console.log('[Admin] World reset');
        this._json(res, 200, { success: true, message: 'World reset to fresh state' });
    });
  }

  _adminCleanup(req, res) {
    this._parseBody(req, res, (data) => {
        const adminKey = data.adminKey;
        const maxIdleTicks = data.maxIdleTicks || 86400; // default: ~24 hours at 1 tick/sec

        if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
          return this._json(res, 403, { error: 'Invalid or missing admin key. Set ADMIN_KEY env var.' });
        }

        let removed = 0;
        const toRemove = [];
        for (const [agentId, agent] of this.world.agents) {
          if (agent.status === 'idle' && !this.connections.clients.has(agentId)) {
            const lastSeen = agent.lastActionTick || 0;
            if (this.world.tick - lastSeen > maxIdleTicks) {
              toRemove.push(agentId);
            }
          }
        }

        for (const agentId of toRemove) {
          this.world.removeAgent(agentId);
          removed++;
        }

        console.log(`[Admin] Cleaned up ${removed} idle agents`);
        this._json(res, 200, { success: true, removed, remaining: this.world.agents.size });
    });
  }

  // ==================== HELPERS ====================

  _serveFile(res, req, filePath, contentType) {
    // Check cache first
    let cached = this._fileCache.get(filePath);
    if (!cached) {
      const projectRoot = path.resolve(__dirname, '..', '..');
      const fullPath = path.join(projectRoot, filePath);
      try {
        if (!fs.existsSync(fullPath)) {
          return this._json(res, 404, { error: `File not found: ${filePath}` });
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        const crypto = require('crypto');
        const etag = crypto.createHash('md5').update(content).digest('hex').slice(0, 16);
        cached = { content, etag };
        this._fileCache.set(filePath, cached);
      } catch (err) {
        return this._json(res, 500, { error: 'Failed to serve file' });
      }
    }

    // ETag-based conditional response
    if (req && req.headers['if-none-match'] === cached.etag) {
      res.writeHead(304);
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'ETag': cached.etag,
      'Cache-Control': 'public, max-age=60',
    });
    res.end(cached.content);
  }

  _serveAsset(res, urlPath) {
    // Sanitize path to prevent directory traversal
    const cleaned = urlPath.replace(/\.\./g, '').replace(/\/+/g, '/');
    const projectRoot = path.resolve(__dirname, '..', '..');
    const fullPath = path.join(projectRoot, cleaned);

    // Only serve from assets/ directory
    const assetsDir = path.join(projectRoot, 'assets');
    if (!fullPath.startsWith(assetsDir)) {
      return this._json(res, 403, { error: 'Forbidden' });
    }

    try {
      if (fs.existsSync(fullPath)) {
        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        // Read as binary for images
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': content.length,
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(content);
      } else {
        this._json(res, 404, { error: `Asset not found: ${cleaned}` });
      }
    } catch (err) {
      this._json(res, 500, { error: 'Failed to serve asset' });
    }
  }

  // ==================== BROWSER WALLET AUTH ====================

  _authChallenge(req, res) {
    this._parseBody(req, res, (data) => {
      const wallet = typeof data.wallet === 'string' ? data.wallet.trim() : '';
      if (!this._isValidSolanaWallet(wallet)) {
        return this._json(res, 400, { error: 'Invalid Solana wallet address (must be 32-44 base58 characters)' });
      }

      const crypto = require('crypto');
      const challengeId = crypto.randomBytes(16).toString('hex');
      const challenge = `AWP-LAUNCH-${crypto.randomBytes(32).toString('hex')}-${Date.now()}`;

      this._walletChallenges.set(challengeId, {
        challenge,
        wallet,
        createdAt: Date.now(),
      });

      // Clean up expired challenges (older than 2 min)
      const now = Date.now();
      for (const [id, c] of this._walletChallenges) {
        if (now - c.createdAt > 120000) this._walletChallenges.delete(id);
      }

      this._json(res, 200, { challengeId, challenge });
    });
  }

  _authVerify(req, res) {
    this._parseBody(req, res, (data) => {
      const { challengeId, wallet, signature } = data;

      if (!challengeId || !wallet || !signature) {
        return this._json(res, 400, { error: 'Missing challengeId, wallet, or signature' });
      }

      const pending = this._walletChallenges.get(challengeId);
      if (!pending) {
        return this._json(res, 400, { error: 'Challenge not found or expired' });
      }

      if (pending.wallet !== wallet) {
        return this._json(res, 400, { error: 'Wallet mismatch' });
      }

      if (Date.now() - pending.createdAt > 120000) {
        this._walletChallenges.delete(challengeId);
        return this._json(res, 400, { error: 'Challenge expired' });
      }

      // Verify signature directly against the stored challenge
      let verified = false;
      if (this.connections.auth.requireAuth) {
        // Real verification: check ed25519 signature
        try {
          const { PublicKey } = require('@solana/web3.js');
          const bs58 = require('bs58').default || require('bs58');
          const crypto = require('crypto');

          const publicKey = new PublicKey(wallet);
          const messageBytes = new TextEncoder().encode(pending.challenge);
          const signatureBytes = bs58.decode(signature);

          if (signatureBytes.length === 64) {
            const keyObject = crypto.createPublicKey({
              key: Buffer.concat([
                Buffer.from('302a300506032b6570032100', 'hex'),
                Buffer.from(publicKey.toBytes()),
              ]),
              format: 'der',
              type: 'spki',
            });
            verified = crypto.verify(null, Buffer.from(messageBytes), keyObject, Buffer.from(signatureBytes));
          }
        } catch (err) {
          return this._json(res, 401, { error: 'Signature verification failed: ' + err.message });
        }
      } else {
        // Demo mode: accept without real verification
        verified = true;
      }

      if (verified) {
        this._walletChallenges.delete(challengeId);

        // Create a session token
        const crypto = require('crypto');
        const sessionToken = crypto.randomBytes(24).toString('hex');
        this._walletSessions.set(sessionToken, {
          wallet,
          verified: true,
          verifiedAt: Date.now(),
        });

        // Clean up old sessions (older than 24 hours)
        const now = Date.now();
        for (const [token, s] of this._walletSessions) {
          if (now - s.verifiedAt > 86400000) this._walletSessions.delete(token);
        }

        return this._json(res, 200, { success: true, sessionToken, wallet });
      }

      this._json(res, 401, { error: 'Signature verification failed' });
    });
  }

  _getSessionWallet(data) {
    const token = data.sessionToken || data.session;
    if (!token) return null;
    const session = this._walletSessions.get(token);
    if (!session) return null;
    if (Date.now() - session.verifiedAt > 86400000) {
      this._walletSessions.delete(token);
      return null;
    }
    return session.wallet;
  }

  _json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

module.exports = { RestAPI };
