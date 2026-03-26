/**
 * Agent World Protocol — Main Server Entry Point
 * 
 * Wires together: Database, WorldState, TickEngine, ConnectionManager, RestAPI, Bridges
 */

const { WorldState } = require('./server/WorldState');
const { TickEngine } = require('./server/TickEngine');
const { ConnectionManager } = require('./server/ConnectionManager');
const { RestAPI } = require('./server/RestAPI');
const { BridgeManager } = require('./bridges/BridgeManager');
const { SolanaBridge } = require('./bridges/SolanaBridge');
const { JupiterBridge } = require('./bridges/JupiterBridge');
const { PumpFunBridge } = require('./bridges/PumpFunBridge');
const { NFTBridge } = require('./bridges/NFTBridge');
const { PolymarketBridge } = require('./bridges/PolymarketBridge');
const { SocialBridge } = require('./bridges/SocialBridge');
const { DataBridge } = require('./bridges/DataBridge');
const { Database } = require('./database/Database');

const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000'),            // single port for Render/Railway
  WS_PORT: parseInt(process.env.WS_PORT || '8080'),       // only used in dual-port mode
  API_PORT: parseInt(process.env.API_PORT || process.env.PORT || '3000'),
  TICK_RATE: parseInt(process.env.TICK_RATE || '1000'),
  PERCEPTION_RADIUS: parseInt(process.env.PERCEPTION_RADIUS || '10'),
  ZONE_SIZE: parseInt(process.env.ZONE_SIZE || '32'),
  SOLANA_RPC: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  DRY_RUN: process.env.DRY_RUN !== 'false',
  FEE_WALLET: process.env.FEE_WALLET || null,
  DATABASE_URL: process.env.DATABASE_URL || null,
  DB_SAVE_INTERVAL: parseInt(process.env.DB_SAVE_INTERVAL || '30000'),
};

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║         AGENT WORLD PROTOCOL v0.1            ║');
  console.log('║    An open world for autonomous AI agents     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // Database
  const db = new Database({
    connectionString: CONFIG.DATABASE_URL,
    saveInterval: CONFIG.DB_SAVE_INTERVAL,
  });
  await db.connect();

  // World state
  const world = new WorldState({
    PERCEPTION_RADIUS: CONFIG.PERCEPTION_RADIUS,
    ZONE_SIZE: CONFIG.ZONE_SIZE,
  });

  const loaded = await db.loadWorld(world);
  if (!loaded) {
    console.log(`[World] Fresh world: ${world.zones.size} zones, ${world.tiles.size} tiles`);
  }

  // Tick engine
  const engine = new TickEngine(world, { tickRate: CONFIG.TICK_RATE });

  // WebSocket connections
  const connections = new ConnectionManager(world, engine, { port: CONFIG.WS_PORT });

  // REST API
  const api = new RestAPI(world, connections, { port: CONFIG.API_PORT });

  // Bridges
  const bridgeManager = new BridgeManager(world, { feeCollectorWallet: CONFIG.FEE_WALLET });
  bridgeManager.register('solana', new SolanaBridge({ rpcUrl: CONFIG.SOLANA_RPC, feeWallet: CONFIG.FEE_WALLET, dryRun: CONFIG.DRY_RUN }));
  bridgeManager.register('jupiter', new JupiterBridge({ feeWallet: CONFIG.FEE_WALLET, dryRun: CONFIG.DRY_RUN }));
  bridgeManager.register('pumpfun', new PumpFunBridge({ feeWallet: CONFIG.FEE_WALLET, dryRun: CONFIG.DRY_RUN }));
  bridgeManager.register('nft', new NFTBridge({ rpcUrl: CONFIG.SOLANA_RPC, feeWallet: CONFIG.FEE_WALLET, dryRun: CONFIG.DRY_RUN }));
  bridgeManager.register('polymarket', new PolymarketBridge({ feeWallet: CONFIG.FEE_WALLET, dryRun: CONFIG.DRY_RUN }));
  bridgeManager.register('social', new SocialBridge({ dryRun: CONFIG.DRY_RUN }));
  bridgeManager.register('data', new DataBridge({ dryRun: CONFIG.DRY_RUN }));

  engine.on('tick', (tickResult) => {
    for (const event of tickResult.events) {
      if (event.type === 'bridge_request') {
        bridgeManager.execute(event.agentId, event.bridge, event.bridgeAction, event.params || {})
          .then(result => {
            const client = connections.clients.get(event.agentId);
            if (client && client.ws.readyState === 1) {
              client.ws.send(JSON.stringify({ type: 'bridge_result', bridge: event.bridge, action: event.bridgeAction, result }));
            }
          })
          .catch(err => console.error(`[Bridge] ${event.bridge}/${event.bridgeAction}: ${err.message}`));
      }
    }
  });

  api.bridgeManager = bridgeManager;

  engine.on('tick', (tickResult) => {
    api.broadcastSSE({
      type: 'tick',
      tick: tickResult.tick,
      events: tickResult.events,
      stats: { agents: tickResult.agentCount, zones: tickResult.zoneCount, processingTime: tickResult.processingTime },
    });
  });

  // Start everything — single port mode (REST + WebSocket on same port)
  const httpServer = api.start();
  connections.start(httpServer); // attach WebSocket to the same HTTP server
  engine.start();
  db.startAutoSave(world);

  console.log('');
  console.log(`[Server] Running on port ${CONFIG.API_PORT} (HTTP + WebSocket combined)`);
  console.log(`[Server] Tick Rate:  ${CONFIG.TICK_RATE}ms`);
  console.log(`[Server] Bridges:    solana, jupiter, pumpfun, nft, polymarket, social, data (dryRun: ${CONFIG.DRY_RUN})`);
  console.log(`[Server] Database:   ${db.enabled ? 'PostgreSQL (persistent)' : 'Memory only (no DATABASE_URL)'}`);
  console.log('');
  console.log(`[Server] Landing:    http://localhost:${CONFIG.API_PORT}/`);
  console.log(`[Server] Viewer:     http://localhost:${CONFIG.API_PORT}/viewer`);
  console.log(`[Server] Dashboard:  http://localhost:${CONFIG.API_PORT}/dashboard`);
  console.log(`[Server] WebSocket:  ws://localhost:${CONFIG.API_PORT}`);
  console.log(`[Server] API Stats:  http://localhost:${CONFIG.API_PORT}/api/stats`);
  console.log('');
  console.log('[Server] World is live. Waiting for agents to connect...');
  console.log('');

  // Graceful shutdown — save world before exit
  async function shutdown() {
    console.log('\n[Server] Shutting down...');
    engine.stop();
    if (db.enabled) {
      console.log('[Server] Saving world state...');
      await db.saveWorld(world);
      await db.close();
    }
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
