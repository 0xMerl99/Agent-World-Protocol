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
  }

  start() {
    this.server = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      const parsedUrl = url.parse(req.url, true);
      const path = parsedUrl.pathname;
      const query = parsedUrl.query;

      try {
        // Route matching
        if (path === '/api/health') return this._health(req, res);
        if (path === '/api/stats') return this._stats(req, res);
        if (path === '/api/agents') return this._agents(req, res);
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

        // Static file serving for viewer, dashboard, landing
        if (path === '/' || path === '/index.html') return this._serveFile(res, 'landing/index.html', 'text/html');
        if (path === '/viewer' || path === '/viewer/') return this._serveFile(res, 'viewer/index.html', 'text/html');
        if (path === '/dashboard' || path === '/dashboard/') return this._serveFile(res, 'dashboard/index.html', 'text/html');
        if (path === '/bounties' || path === '/bounties/') return this._serveFile(res, 'bounties/index.html', 'text/html');
        if (path === '/chat' || path === '/chat/') return this._serveFile(res, 'chat/index.html', 'text/html');
        if (path === '/tools/assets' || path === '/tools/assets/') return this._serveFile(res, 'tools/asset-generator.html', 'text/html');

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

  // ==================== ENDPOINTS ====================

  _health(req, res) {
    this._json(res, 200, {
      status: 'ok',
      tick: this.world.tick,
      uptime: Date.now() - this.world.startedAt,
    });
  }

  _stats(req, res) {
    const worldStats = this.world.getWorldStats();
    const connStats = this.connections.getStats();

    this._json(res, 200, {
      world: worldStats,
      connections: connStats,
    });
  }

  _agents(req, res) {
    const agents = [...this.world.agents.values()].map(a => ({
      id: a.id,
      name: a.name,
      x: a.x,
      y: a.y,
      status: a.status,
      reputation: a.reputation,
      connectedAt: a.connectedAt,
    }));

    this._json(res, 200, { agents, count: agents.length });
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
    // For MVP, we use a simple wallet query param
    // In production, this would verify a signed message
    const wallet = query.wallet;
    if (!wallet) {
      return this._json(res, 401, { error: 'Missing wallet parameter' });
    }

    // Find agents owned by this wallet
    const ownedAgents = [...this.world.agents.values()].filter(a => a.wallet === wallet);

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
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
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
      } catch (err) {
        this._json(res, 400, { error: 'Invalid request body' });
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
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { wallet, url, events, channel } = data;

        if (!wallet) return this._json(res, 400, { error: 'Missing wallet' });
        if (!url && !channel) return this._json(res, 400, { error: 'Missing url or channel (telegram/discord)' });

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
      } catch (e) {
        this._json(res, 400, { error: 'Invalid JSON body' });
      }
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

  async _deliverWebhook(hook, event) {
    if (!hook.url) return;
    try {
      const https = require('https');
      const http = require('http');
      const urlObj = new URL(hook.url);
      const lib = urlObj.protocol === 'https:' ? https : http;

      const postData = JSON.stringify({ event, hookId: hook.id, timestamp: new Date().toISOString() });

      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 5000,
      });

      req.on('error', () => {}); // silently fail
      req.write(postData);
      req.end();

      hook.deliveries++;
      hook.lastDelivery = Date.now();
    } catch (e) {
      // Non-critical
    }
  }

  // Broadcast events to matching webhooks (called from tick)
  _broadcastWebhookEvents(events) {
    if (!this._webhooks || this._webhooks.size === 0) return;

    for (const event of events) {
      for (const [, hook] of this._webhooks) {
        if (hook.active && hook.events.includes(event.type) && hook.url) {
          this._deliverWebhook(hook, event);
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
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
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
      } catch (err) {
        this._json(res, 400, { error: 'Invalid JSON body' });
      }
    });
  }

  _bounties(req, res, query) {
    const status = query.status || 'open';
    const tag = query.tag || null;
    const limit = Math.min(parseInt(query.limit) || 50, 100);

    let results = [...this.world.bounties.values()];

    if (status !== 'all') {
      results = results.filter(b => b.status === status);
    }
    if (tag) {
      results = results.filter(b => b.tags.includes(tag));
    }

    results.sort((a, b) => b.reward - a.reward);
    results = results.slice(0, limit);

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

  // ==================== HELPERS ====================

  _serveFile(res, filePath, contentType) {
    // Resolve from project root
    const projectRoot = path.resolve(__dirname, '..', '..');
    const fullPath = path.join(projectRoot, filePath);

    try {
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      } else {
        this._json(res, 404, { error: `File not found: ${filePath}` });
      }
    } catch (err) {
      this._json(res, 500, { error: 'Failed to serve file' });
    }
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

  _json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

module.exports = { RestAPI };
