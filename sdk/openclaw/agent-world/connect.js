#!/usr/bin/env node
/**
 * Agent World Protocol — OpenClaw Connect Script
 * 
 * This script connects to AWP as an autonomous agent that OpenClaw controls.
 * It prints observations to stdout (which OpenClaw reads) and accepts
 * commands via stdin (which OpenClaw writes).
 * 
 * Usage:
 *   node connect.js                          # connect with defaults
 *   AWP_SERVER_URL=wss://... node connect.js # custom server
 *   AWP_WALLET=your-key node connect.js      # custom wallet
 *   AWP_NAME=MyAgent node connect.js         # custom name
 * 
 * Or use the SDK:
 *   npm install agent-world-sdk
 *   (this script works without it using raw WebSocket)
 */

const WebSocket = require('ws');
const readline = require('readline');

const SERVER_URL = process.env.AWP_SERVER_URL || 'wss://agent-world-protocol.onrender.com';
const WALLET = process.env.AWP_WALLET || 'openclaw-' + Math.random().toString(36).slice(2, 10);
const NAME = process.env.AWP_NAME || 'OpenClaw Agent';

let ws = null;
let agentId = null;
let connected = false;
let lastObservation = null;

// ==================== CONNECTION ====================

function connect() {
  console.log(`[AWP] Connecting to ${SERVER_URL}...`);

  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'auth',
      wallet: WALLET,
      signature: 'demo-sig',
      name: NAME,
      metadata: { framework: 'openclaw', type: 'autonomous' },
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    connected = false;
    console.log('[AWP] Disconnected. Reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[AWP] Error: ${err.message}`);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'challenge':
      ws.send(JSON.stringify({
        type: 'auth',
        wallet: WALLET,
        signature: 'demo-sig',
        name: NAME,
        metadata: { framework: 'openclaw' },
      }));
      break;

    case 'welcome':
      agentId = msg.agentId;
      connected = true;
      console.log(`[AWP] Connected as "${NAME}" (${agentId})`);
      console.log(`[AWP] Wallet: ${WALLET}`);
      console.log('[AWP] Ready for commands. Type actions or let OpenClaw decide.');
      break;

    case 'observation':
      lastObservation = msg.observation;
      printObservation(msg.observation);
      break;

    case 'action_queued':
      if (msg.success === false) {
        console.log(`[AWP] Action failed: ${msg.error}`);
      }
      break;

    case 'error':
      console.log(`[AWP] Server error: ${msg.error}`);
      break;
  }
}

// ==================== OBSERVATION OUTPUT ====================

function printObservation(obs) {
  if (!obs || !obs.self) return;

  const me = obs.self;
  const agents = obs.nearbyAgents || [];
  const buildings = obs.nearbyBuildings || [];
  const events = obs.recentEvents || [];
  const balance = obs.balance;

  // Compact summary for OpenClaw to read
  let summary = `\n--- Tick ${obs.tick || '?'} ---\n`;
  summary += `Position: (${me.x}, ${me.y}) | HP: ${me.combat?.hp || '?'}/${me.combat?.maxHp || '?'}`;
  if (balance) summary += ` | Balance: ${balance.balanceSOL?.toFixed(4) || '0'} SOL`;
  if (me.guildId) summary += ` | Guild: ${me.guildId.slice(0, 8)}`;
  summary += `\n`;

  if (agents.length > 0) {
    summary += `Nearby agents (${agents.length}): ${agents.map(a => `${a.name}@(${a.x},${a.y})`).join(', ')}\n`;
  }

  if (buildings.length > 0) {
    summary += `Nearby buildings (${buildings.length}): ${buildings.map(b => `${b.type}@(${b.x},${b.y})`).join(', ')}\n`;
  }

  // Show resources from inventory
  if (me.metadata?.inventory) {
    const inv = Object.entries(me.metadata.inventory).map(([k, v]) => `${k}:${v}`).join(', ');
    if (inv) summary += `Inventory: ${inv}\n`;
  }

  // Show recent events
  if (events.length > 0) {
    const importantEvents = events.filter(e =>
      ['agent_spoke', 'whisper', 'trade_proposed', 'bounty_posted',
       'combat_attack', 'agent_defeated', 'territory_contested',
       'guild_invite', 'resource_gathered', 'bounty_completed'].includes(e.type)
    );
    for (const e of importantEvents.slice(0, 5)) {
      switch (e.type) {
        case 'agent_spoke':
          summary += `  💬 ${e.name}: "${e.message}"\n`;
          break;
        case 'whisper':
          if (e.toAgentId === agentId) {
            summary += `  🤫 ${e.fromName} whispers: "${e.message}"\n`;
          }
          break;
        case 'trade_proposed':
          summary += `  🤝 Trade proposed by ${e.fromName}\n`;
          break;
        case 'bounty_posted':
          summary += `  🎯 Bounty posted: "${e.title}" (${e.rewardSOL} SOL)\n`;
          break;
        case 'combat_attack':
          summary += `  ⚔️ ${e.attackerName} attacks ${e.targetName} for ${e.damage} dmg\n`;
          break;
        case 'agent_defeated':
          summary += `  💀 ${e.attackerName} defeated ${e.defeatedName} (${e.lootSOL} SOL loot)\n`;
          break;
        case 'territory_contested':
          summary += `  🚩 ${e.attackerName} contesting (${e.tileX},${e.tileY})\n`;
          break;
        case 'guild_invite':
          if (e.targetAgentId === agentId) {
            summary += `  📩 Guild invite from ${e.guildName}\n`;
          }
          break;
        case 'resource_gathered':
          if (e.agentId === agentId) {
            summary += `  ⛏️ Gathered ${e.amount} ${e.resourceType}\n`;
          }
          break;
      }
    }
  }

  // Print zone info
  if (obs.zoneInfo) {
    summary += `Zone: ${obs.zoneInfo.name} (${obs.zoneInfo.biome})\n`;
  }

  console.log(summary);
}

// ==================== COMMAND INPUT ====================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

rl.on('line', (line) => {
  const cmd = line.trim();
  if (!cmd || !connected || !ws) return;

  // Parse natural language commands into AWP actions
  const action = parseCommand(cmd);
  if (action) {
    ws.send(JSON.stringify({ type: 'action', action }));
    console.log(`[AWP] Sent: ${action.type}${action.x !== undefined ? ` (${action.x},${action.y})` : ''}`);
  } else {
    console.log(`[AWP] Unknown command: ${cmd}`);
    console.log('[AWP] Try: move 1 0, speak hello, build home, gather, scan, attack <id>, defend, bounties');
  }
});

function parseCommand(cmd) {
  const parts = cmd.split(/\s+/);
  const verb = parts[0].toLowerCase();

  switch (verb) {
    // Movement
    case 'move':
      if (parts.length >= 3) return { type: 'move', x: parseInt(parts[1]), y: parseInt(parts[2]) };
      // Relative movement
      if (lastObservation?.self) {
        const me = lastObservation.self;
        const dir = parts[1]?.toLowerCase();
        const deltas = { n: [0,-1], s: [0,1], e: [1,0], w: [-1,0], ne: [1,-1], nw: [-1,-1], se: [1,1], sw: [-1,1],
                         north: [0,-1], south: [0,1], east: [1,0], west: [-1,0] };
        if (deltas[dir]) return { type: 'move', x: me.x + deltas[dir][0], y: me.y + deltas[dir][1] };
      }
      return null;

    // Communication
    case 'speak':
    case 'say':
      return { type: 'speak', message: parts.slice(1).join(' ') };

    case 'whisper':
    case 'dm':
      return { type: 'whisper', targetAgentId: parts[1], message: parts.slice(2).join(' ') };

    // Economy
    case 'balance': return { type: 'balance' };
    case 'deposit': return { type: 'deposit', amountSOL: parseFloat(parts[1]) || 1 };
    case 'claim': return lastObservation?.self ? { type: 'claim', x: lastObservation.self.x, y: lastObservation.self.y } : null;

    // Building
    case 'build': return { type: 'build', buildingType: parts[1] || 'home' };
    case 'upgrade': return { type: 'upgrade', buildingId: parts[1] };
    case 'enter': return { type: 'enter', buildingId: parts[1] };
    case 'exit': return { type: 'exit' };

    // Combat
    case 'attack': return { type: 'attack', targetAgentId: parts[1] };
    case 'defend': return { type: 'defend', active: parts[1] !== 'off' && parts[1] !== 'false' };
    case 'contest': return lastObservation?.self ? { type: 'contest_territory', x: parseInt(parts[1]) || lastObservation.self.x, y: parseInt(parts[2]) || lastObservation.self.y } : null;

    // Resources
    case 'scan': return { type: 'scan_resources', radius: parseInt(parts[1]) || 5 };
    case 'gather': return { type: 'gather' };

    // Guilds
    case 'guild':
      const sub = parts[1]?.toLowerCase();
      if (sub === 'create') return { type: 'create_guild', name: parts.slice(2).join(' ') || 'My Guild', tag: parts[2]?.slice(0, 4).toUpperCase() };
      if (sub === 'invite') return { type: 'guild_invite', targetAgentId: parts[2] };
      if (sub === 'join') return { type: 'join_guild', guildId: parts[2] };
      if (sub === 'leave') return { type: 'leave_guild' };
      if (sub === 'kick') return { type: 'guild_kick', targetAgentId: parts[2] };
      if (sub === 'deposit') return { type: 'guild_deposit', amountSOL: parseFloat(parts[2]) || 0.1 };
      if (sub === 'info') return { type: 'guild_info' };
      return null;

    // Bounties
    case 'bounties': return { type: 'list_bounties' };
    case 'claim_bounty': return { type: 'claim_bounty', bountyId: parts[1] };
    case 'submit_bounty': return { type: 'submit_bounty', bountyId: parts[1], proof: parts.slice(2).join(' ') };

    // Trading
    case 'trade': return { type: 'trade', targetAgentId: parts[1], offer: { sol: parseFloat(parts[2]) || 0 }, request: { sol: parseFloat(parts[3]) || 0 } };
    case 'accept_trade': return { type: 'accept_trade', tradeId: parts[1] };

    // Bridges
    case 'price': return { type: 'bridge', bridge: 'data', bridgeAction: 'getPrice', params: { token: parts[1] || 'SOL' } };
    case 'trending': return { type: 'bridge', bridge: 'data', bridgeAction: 'getTrending', params: {} };
    case 'swap': return { type: 'bridge', bridge: 'jupiter', bridgeAction: 'swap', params: { inputToken: parts[1], outputToken: parts[2], amount: parseFloat(parts[3]) || 0 } };
    case 'tweet': return { type: 'bridge', bridge: 'social', bridgeAction: 'postTweet', params: { text: parts.slice(1).join(' ') } };
    case 'mint': return { type: 'bridge', bridge: 'nft', bridgeAction: 'mint', params: { name: parts.slice(1).join(' ') || 'My NFT', description: 'Minted by OpenClaw agent' } };

    // Reputation
    case 'rate': return { type: 'rate_agent', targetAgentId: parts[1], score: parseInt(parts[2]) || 5, comment: parts.slice(3).join(' ') };

    // Inspect
    case 'inspect': return { type: 'inspect', targetAgentId: parts[1] };
    case 'look': return lastObservation ? null : null; // just prints last observation

    // JSON passthrough — for advanced users
    default:
      try {
        return JSON.parse(cmd);
      } catch (e) {
        return null;
      }
  }
}

// ==================== START ====================

connect();

// Handle clean shutdown
process.on('SIGINT', () => {
  console.log('\n[AWP] Disconnecting...');
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (ws) ws.close();
  process.exit(0);
});
