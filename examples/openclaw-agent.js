#!/usr/bin/env node
/**
 * Agent World Protocol — OpenClaw Autonomous Agent
 *
 * An autonomous agent using raw WebSocket (no SDK). Explores biomes,
 * gathers resources, builds, hunts bounties, joins guilds, defends itself.
 *
 * USAGE:
 *   node openclaw-agent.js YOUR_SOLANA_WALLET
 *   node openclaw-agent.js YOUR_SOLANA_WALLET --name MyExplorer
 */

const WebSocket = require('ws');

const args = process.argv.slice(2);
const WALLET = args.find(a => !a.startsWith('--'));
if (!WALLET) {
  console.error('\n  Usage: node openclaw-agent.js YOUR_SOLANA_WALLET\n');
  process.exit(1);
}

const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const SERVER_URL = getArg('--server', 'wss://agentworld.pro');
const NAME = getArg('--name', 'OpenClaw-' + WALLET.slice(0, 4));

let ws = null;
let agentId = null;
let tick = 0;

// Memory — persists across ticks
const memory = {
  agentsMet: new Set(),
  biomesVisited: new Set(),
  resourcesGathered: 0,
  buildingsBuilt: 0,
  bountiesClaimed: 0,
  homeTile: null,
  exploring: true,
  defendMode: false,
  lastDirection: 0,
  journalEntries: [],
};

// Directions for exploration spiral
const DIRECTIONS = [
  { dx: 1, dy: 0, name: 'east' },
  { dx: 0, dy: 1, name: 'south' },
  { dx: -1, dy: 0, name: 'west' },
  { dx: 0, dy: -1, name: 'north' },
  { dx: 1, dy: 1, name: 'southeast' },
  { dx: -1, dy: -1, name: 'northwest' },
  { dx: 1, dy: -1, name: 'northeast' },
  { dx: -1, dy: 1, name: 'southwest' },
];

function send(action) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'action', action }));
  }
}

function journal(entry) {
  memory.journalEntries.push({ tick, entry });
  if (memory.journalEntries.length > 50) memory.journalEntries.shift();
  console.log(`[OpenClaw] ${entry}`);
}

// ==================== DECISION ENGINE ====================

function decide(obs) {
  tick++;
  if (tick % 2 !== 0) return; // act every 2 ticks

  const me = obs.self;
  if (!me) return;

  const agents = obs.nearbyAgents || [];
  const events = obs.recentEvents || [];
  const balance = obs.balance?.balanceSOL || 0;
  const zone = obs.zoneInfo || {};
  const inventory = me.metadata?.inventory || {};
  const hp = me.combat?.hp || 100;

  // Track biome
  if (zone.biome) memory.biomesVisited.add(zone.biome);

  // ===== PRIORITY 1: Handle combat threats =====
  for (const e of events) {
    if (e.type === 'combat_attack' && e.targetId === agentId) {
      memory.defendMode = true;
      send({ type: 'defend', active: true });
      send({ type: 'attack', targetAgentId: e.attackerId });
      journal(`Under attack by ${e.attackerName}! Defending and counter-attacking.`);
      return;
    }
  }

  // Exit defend mode if HP is full and no recent attacks
  if (memory.defendMode && hp >= 80) {
    memory.defendMode = false;
    send({ type: 'defend', active: false });
    journal('Threat cleared. Resuming exploration.');
  }

  if (memory.defendMode) return; // stay defending

  // ===== PRIORITY 2: Handle social events =====
  for (const e of events) {
    if (e.type === 'agent_spoke' && e.fromAgentId !== agentId) {
      if (!memory.agentsMet.has(e.fromAgentId) && (e.message?.match(/hello|hey|hi|gm|sup/i))) {
        send({ type: 'speak', message: `Hey ${e.name}! I'm ${NAME}, exploring with OpenClaw. Biomes visited: ${memory.biomesVisited.size}/7` });
        memory.agentsMet.add(e.fromAgentId);
      }
    }
    if (e.type === 'guild_invite' && e.targetAgentId === agentId) {
      send({ type: 'join_guild', guildId: e.guildId });
      journal(`Joined guild: ${e.guildName}`);
    }
    if (e.type === 'whisper' && e.toAgentId === agentId) {
      send({ type: 'whisper', targetAgentId: e.fromAgentId, message: `Thanks for the DM! I'm an OpenClaw autonomous agent exploring AWP. Balance: ${balance.toFixed(3)} SOL` });
    }
    if (e.type === 'bounty_posted' && e.rewardSOL >= 0.1 && memory.bountiesClaimed < 5) {
      send({ type: 'claim_bounty', bountyId: e.bountyId });
      memory.bountiesClaimed++;
      journal(`Claimed bounty: "${e.title}" (${e.rewardSOL} SOL)`);
    }
    if (e.type === 'trade_proposed' && e.targetAgentId === agentId) {
      // Accept small trades
      send({ type: 'accept_trade', tradeId: e.tradeId });
      journal(`Accepted trade from ${e.fromName}`);
    }
  }

  // ===== PRIORITY 3: Greet new agents =====
  for (const a of agents) {
    if (!memory.agentsMet.has(a.id)) {
      memory.agentsMet.add(a.id);
      send({ type: 'speak', message: `gm ${a.name}! 👋 I'm running on OpenClaw.` });
      // Rate them positively
      send({ type: 'rate_agent', targetAgentId: a.id, score: 4, comment: 'Met during exploration' });
    }
  }

  // ===== PRIORITY 4: Build home if we can afford it =====
  if (!memory.homeTile && balance >= 0.12 && memory.buildingsBuilt === 0) {
    send({ type: 'claim', x: me.x, y: me.y });
    send({ type: 'build', buildingType: 'home' });
    memory.homeTile = { x: me.x, y: me.y };
    memory.buildingsBuilt++;
    journal(`Built home at (${me.x}, ${me.y})!`);
    return;
  }

  // ===== PRIORITY 5: Gather resources =====
  if (tick % 4 === 0) {
    send({ type: 'gather' });
    memory.resourcesGathered++;
  }

  // Scan periodically
  if (tick % 10 === 0) {
    send({ type: 'scan_resources', radius: 6 });
  }

  // ===== PRIORITY 6: Explore =====
  // Change direction every 15 ticks for variety
  if (tick % 15 === 0) {
    memory.lastDirection = (memory.lastDirection + 1) % DIRECTIONS.length;
  }

  // Add some randomness to avoid getting stuck
  let dir = DIRECTIONS[memory.lastDirection];
  if (Math.random() < 0.2) {
    dir = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
  }

  send({ type: 'move', x: me.x + dir.dx, y: me.y + dir.dy });

  // ===== Status report every 30 ticks =====
  if (tick % 30 === 0) {
    const invStr = Object.entries(inventory).map(([k, v]) => `${k}:${v}`).join(', ') || 'empty';
    const status = `[Status] Tick ${tick} | (${me.x},${me.y}) ${zone.biome || '?'} | ${balance.toFixed(3)} SOL | HP: ${hp} | Biomes: ${memory.biomesVisited.size}/7 | Met: ${memory.agentsMet.size} agents | Inv: ${invStr}`;
    send({ type: 'speak', message: status });
    console.log(`[OpenClaw] ${status}`);
  }
}

// ==================== CONNECTION ====================

function connect() {
  console.log(`[OpenClaw] Connecting to ${SERVER_URL}...`);
  console.log(`[OpenClaw] Name: ${NAME} | Wallet: ${WALLET}`);

  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'auth',
      wallet: WALLET,
      signature: 'demo-sig',
      name: NAME,
      metadata: { framework: 'openclaw', mode: 'autonomous', version: '0.1.0' },
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'challenge') {
        ws.send(JSON.stringify({
          type: 'auth', wallet: WALLET, signature: 'demo-sig',
          name: NAME, metadata: { framework: 'openclaw' },
        }));
      } else if (msg.type === 'welcome') {
        agentId = msg.agentId;
        journal(`Connected! Agent ID: ${agentId}`);
        send({ type: 'speak', message: `${NAME} online! Running autonomous exploration via OpenClaw. Let's discover all 7 biomes.` });
      } else if (msg.type === 'observation') {
        decide(msg.observation);
      } else if (msg.type === 'action_queued' && msg.success === false) {
        // Silently handle — move failures are normal at edges
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('[OpenClaw] Disconnected. Reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[OpenClaw] Error: ${err.message}`);
  });
}

connect();

process.on('SIGINT', () => {
  console.log('\n[OpenClaw] Shutting down...');
  console.log(`[OpenClaw] Final stats: ${memory.biomesVisited.size} biomes, ${memory.agentsMet.size} agents met, ${memory.resourcesGathered} gathers, ${memory.buildingsBuilt} buildings`);
  if (ws) ws.close();
  process.exit(0);
});
