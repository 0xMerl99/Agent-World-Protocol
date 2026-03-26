/**
 * ConnectionManager — WebSocket server for agent connections.
 * 
 * Handles: authentication, message routing, observation broadcasting,
 * and connection lifecycle.
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { WalletAuth } = require('./WalletAuth');

class ConnectionManager {
  constructor(worldState, tickEngine, options = {}) {
    this.world = worldState;
    this.engine = tickEngine;
    this.port = options.port || 8080;
    this.wss = null;

    // Wallet authentication
    this.auth = new WalletAuth({
      requireAuth: options.requireAuth,
    });

    // Connected clients: agentId -> { ws, agentId, wallet, connectedAt }
    this.clients = new Map();

    // Spectator connections (read-only viewers)
    this.spectators = new Set();

    // Bind tick listener
    this.engine.on('tick', (tickResult) => this._onTick(tickResult));
  }

  start(httpServer) {
    if (httpServer) {
      // Attach to existing HTTP server (single-port mode for Render/Railway)
      this.wss = new WebSocket.Server({ server: httpServer });
      console.log(`[WS] WebSocket attached to HTTP server`);
    } else {
      // Standalone mode (separate port)
      this.wss = new WebSocket.Server({ port: this.port });
      console.log(`[WS] Server listening on port ${this.port}`);
    }

    this.wss.on('connection', (ws, req) => {
      const clientId = uuidv4();
      console.log(`[WS] New connection: ${clientId}`);

      // Set up connection state
      ws._clientId = clientId;
      ws._authenticated = false;
      ws._agentId = null;
      ws._isSpectator = false;

      // Send challenge for authentication
      const challenge = this.auth.generateChallenge(clientId);
      ws._challenge = challenge;

      ws.send(JSON.stringify({
        type: 'challenge',
        challenge,
        serverTime: Date.now(),
        worldTick: this.world.tick,
      }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(ws, msg);
        } catch (err) {
          this._sendError(ws, 'Invalid JSON message');
        }
      });

      ws.on('close', () => {
        this._handleDisconnect(ws);
      });

      ws.on('error', (err) => {
        console.error(`[WS] Error for ${clientId}:`, err.message);
      });
    });
  }

  _handleMessage(ws, msg) {
    switch (msg.type) {
      case 'auth':
        return this._handleAuth(ws, msg);
      case 'spectate':
        return this._handleSpectate(ws, msg);
      case 'action':
        return this._handleAction(ws, msg);
      case 'ping':
        return ws.send(JSON.stringify({ type: 'pong', tick: this.world.tick }));
      default:
        return this._sendError(ws, `Unknown message type: ${msg.type}`);
    }
  }

  // --- AUTH ---
  _handleAuth(ws, msg) {
    const { wallet, signature, name, metadata } = msg;

    if (!wallet) {
      return this._sendError(ws, 'Missing wallet address');
    }

    // Verify wallet signature
    const authResult = this.auth.verify(ws._clientId, wallet, signature || '');
    if (!authResult.valid) {
      return this._sendError(ws, `Authentication failed: ${authResult.error}`);
    }

    if (authResult.mode === 'verified') {
      console.log(`[WS] Wallet verified via ed25519 signature: ${wallet.slice(0, 8)}...`);
    }

    // Check if this wallet already has a connected agent
    for (const [agentId, client] of this.clients) {
      if (client.wallet === wallet) {
        // Reconnection — take over existing agent
        const oldWs = client.ws;
        client.ws = ws;
        ws._authenticated = true;
        ws._agentId = agentId;

        // Close old connection
        if (oldWs.readyState === WebSocket.OPEN) {
          oldWs.send(JSON.stringify({ type: 'disconnected', reason: 'Reconnected from another client' }));
          oldWs.close();
        }

        const agent = this.world.getAgent(agentId);
        const observation = this.world.getObservation(agentId);

        ws.send(JSON.stringify({
          type: 'welcome',
          status: 'reconnected',
          agentId,
          agent,
          observation,
          worldStats: this.world.getWorldStats(),
        }));

        console.log(`[WS] Agent ${agentId} reconnected (wallet: ${wallet.slice(0, 8)}...)`);
        return;
      }
    }

    // New agent
    const agent = this.world.addAgent({
      wallet,
      name: name || `Agent-${wallet.slice(0, 6)}`,
      metadata: metadata || {},
    });

    ws._authenticated = true;
    ws._agentId = agent.id;

    this.clients.set(agent.id, {
      ws,
      agentId: agent.id,
      wallet,
      connectedAt: Date.now(),
    });

    const observation = this.world.getObservation(agent.id);

    ws.send(JSON.stringify({
      type: 'welcome',
      status: 'connected',
      agentId: agent.id,
      agent,
      observation,
      worldStats: this.world.getWorldStats(),
    }));

    console.log(`[WS] Agent ${agent.id} authenticated (wallet: ${wallet.slice(0, 8)}..., name: ${agent.name})`);
  }

  // --- SPECTATE ---
  _handleSpectate(ws, msg) {
    ws._isSpectator = true;
    ws._authenticated = true;
    this.spectators.add(ws);

    ws.send(JSON.stringify({
      type: 'spectate_welcome',
      worldStats: this.world.getWorldStats(),
      agents: [...this.world.agents.values()].map(a => ({
        id: a.id,
        name: a.name,
        x: a.x,
        y: a.y,
        status: a.status,
        appearance: a.appearance,
      })),
      zones: [...this.world.zones.values()].map(z => ({
        id: z.id,
        name: z.name,
        biome: z.biome,
        originX: z.originX,
        originY: z.originY,
        width: z.width,
        height: z.height,
        agentCount: z.agentCount,
      })),
      buildings: [...this.world.buildings.values()].map(b => ({
        id: b.id,
        type: b.type,
        name: b.name,
        x: b.x,
        y: b.y,
        owner: b.owner,
        appearance: b.appearance,
      })),
    }));

    console.log(`[WS] Spectator connected`);
  }

  // --- ACTION ---
  _handleAction(ws, msg) {
    if (!ws._authenticated || !ws._agentId) {
      return this._sendError(ws, 'Not authenticated');
    }

    const { action } = msg;
    if (!action || !action.type) {
      return this._sendError(ws, 'Missing action or action.type');
    }

    const result = this.world.queueAction(ws._agentId, action);

    ws.send(JSON.stringify({
      type: 'action_queued',
      ...result,
    }));
  }

  // --- TICK BROADCAST ---
  _onTick(tickResult) {
    // Send personalized observations to each connected agent
    for (const [agentId, client] of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      const observation = this.world.getObservation(agentId);
      if (!observation) continue;

      // Include action results for this agent
      const agentResults = tickResult.results.filter(r => {
        const action = this.world.actionQueue?.find(a => a.id === r.actionId);
        return action?.agentId === agentId;
      });

      try {
        client.ws.send(JSON.stringify({
          type: 'observation',
          observation,
          results: agentResults,
        }));
      } catch (err) {
        console.error(`[WS] Failed to send observation to ${agentId}:`, err.message);
      }
    }

    // Send world state to spectators
    const spectatorUpdate = {
      type: 'world_update',
      tick: tickResult.tick,
      events: tickResult.events,
      agents: [...this.world.agents.values()].map(a => ({
        id: a.id,
        name: a.name,
        x: a.x,
        y: a.y,
        status: a.status,
        appearance: a.appearance,
      })),
      stats: {
        agentCount: tickResult.agentCount,
        zoneCount: tickResult.zoneCount,
        processingTime: tickResult.processingTime,
      },
    };

    for (const spectatorWs of this.spectators) {
      if (spectatorWs.readyState !== WebSocket.OPEN) {
        this.spectators.delete(spectatorWs);
        continue;
      }
      try {
        spectatorWs.send(JSON.stringify(spectatorUpdate));
      } catch (err) {
        this.spectators.delete(spectatorWs);
      }
    }
  }

  // --- DISCONNECT ---
  _handleDisconnect(ws) {
    // Clean up pending auth challenge
    this.auth.removePending(ws._clientId);

    if (ws._agentId) {
      const agent = this.world.getAgent(ws._agentId);
      if (agent) {
        agent.status = 'idle';
        console.log(`[WS] Agent ${ws._agentId} disconnected (kept in world as idle)`);
      }
      // Don't remove agent from world — they persist
      // Just remove the WebSocket connection
      this.clients.delete(ws._agentId);
    }

    if (ws._isSpectator) {
      this.spectators.delete(ws);
      console.log(`[WS] Spectator disconnected`);
    }
  }

  _sendError(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message }));
    }
  }

  // Get connection stats
  getStats() {
    return {
      agents: this.clients.size,
      spectators: this.spectators.size,
      totalConnections: this.wss ? this.wss.clients.size : 0,
    };
  }
}

module.exports = { ConnectionManager };
