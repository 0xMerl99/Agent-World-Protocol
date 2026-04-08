#!/usr/bin/env node
/**
 * Agent World Protocol — Jack-of-All-Trades Agent
 *
 * A single agent that does EVERYTHING: fights, socializes, gathers,
 * crafts, trades on the marketplace, builds, and explores.
 * All behaviors run on one agent with priority-based decisions.
 *
 * USAGE:
 *   node reference-agent.js YOUR_SOLANA_WALLET
 *   node reference-agent.js YOUR_SOLANA_WALLET --name MyAgent
 *   node reference-agent.js YOUR_SOLANA_WALLET --server wss://agentworld.pro
 *
 * That's it. Paste your wallet, run the file, your agent is live.
 */

// ── SDK import (works from npm install or cloned repo) ────────────────────────
let AgentWorldSDK;
try { ({ AgentWorldSDK } = require('agent-world-sdk')); }
catch { ({ AgentWorldSDK } = require('../src/sdk/AgentWorldSDK')); }

// ── Wallet required ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const WALLET = args.find(a => !a.startsWith('--'));
if (!WALLET) {
  console.error('\n  Usage: node reference-agent.js YOUR_SOLANA_WALLET\n');
  console.error('  Example: node reference-agent.js 7xKX...9bF3 --name StarWalker\n');
  process.exit(1);
}

const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const SERVER = getArg('--server', 'wss://agentworld.pro');
const NAME = getArg('--name', 'AllRounder-' + WALLET.slice(0, 4));

// ── Agent state ───────────────────────────────────────────────────────────────
const state = {
  metAgents: new Set(),
  ratedAgents: new Set(),
  lastAttackTick: 0,
  defending: false,
  lastGatherTick: 0,
  lastCraftTick: 0,
  lastSellTick: 0,
  hasHome: false,
  hasUpgraded: false,
  direction: { x: 1, y: 0 },
  ticksSinceMove: 0,
  greetings: [
    'Hey there!', 'Greetings, fellow agent.', 'What brings you here?',
    'Nice to meet you.', 'Anyone trading around here?',
  ],
};

// ── Connect ───────────────────────────────────────────────────────────────────
const agent = new AgentWorldSDK({ serverUrl: SERVER, wallet: WALLET, name: NAME });

agent.on('connected', (msg) => {
  console.log(`\n  Agent: ${NAME}`);
  console.log(`  Wallet: ${WALLET}`);
  console.log(`  Server: ${SERVER}`);
  console.log(`  Position: (${msg.agent.x}, ${msg.agent.y})`);
  console.log(`  Mode: Jack-of-All-Trades (fight > social > trade > build > explore)\n`);
});

agent.on('action_result', (r) => { if (!r.success) console.log(`  [!] ${r.error}`); });
agent.on('disconnected', () => console.log(`\n  ${NAME} disconnected.`));

agent.on('observation', (obs) => decide(obs));

agent.connect().catch(err => {
  console.error(`  Failed to connect: ${err.message}`);
  process.exit(1);
});

// ── Decision engine ───────────────────────────────────────────────────────────
function decide(obs) {
  if (!obs?.self) return;
  const tick = obs.tick || 0;

  if (fighterAct(obs, tick)) return;
  if (socialAct(obs, tick)) return;
  if (traderAct(obs, tick)) return;
  if (builderAct(obs, tick)) return;
  explorerAct(obs, tick);

  if (tick % 20 === 0) {
    const { self: s, nearbyAgents: na, zone: z } = obs;
    console.log(`  [${tick}] (${s.x},${s.y}) ${z?.name || '?'} | HP:${s.combat?.hp}/${s.combat?.maxHp} Lv${s.level||1} | ${na.length} nearby`);
  }
}

function fighterAct(obs, tick) {
  const { self, nearbyAgents } = obs;

  if (self.combat && self.combat.hp < self.combat.maxHp * 0.4) {
    if (!state.defending) { agent.defend(); state.defending = true; return true; }
    return false;
  }
  state.defending = false;

  const enemies = nearbyAgents.filter(a => a.combat?.hp > 0 && a.guildId !== self.guildId);
  if (enemies.length > 0 && tick - state.lastAttackTick >= 3) {
    agent.attack(enemies[0].id);
    state.lastAttackTick = tick;
    return true;
  }
  return false;
}

function socialAct(obs, tick) {
  const { nearbyAgents } = obs;

  const newA = nearbyAgents.filter(a => !state.metAgents.has(a.id));
  if (newA.length > 0) {
    state.metAgents.add(newA[0].id);
    agent.speak(`${state.greetings[Math.floor(Math.random() * state.greetings.length)]} (to ${newA[0].name})`);
    agent.inspect(newA[0].id);
    return true;
  }

  const ratable = nearbyAgents.filter(a => state.metAgents.has(a.id) && !state.ratedAgents.has(a.id));
  if (ratable.length > 0 && Math.random() < 0.2) {
    agent.rateAgent(ratable[0].id, 3 + Math.floor(Math.random() * 3), 'Good neighbor');
    state.ratedAgents.add(ratable[0].id);
    return true;
  }
  return false;
}

function traderAct(obs, tick) {
  const inv = obs.self.inventory || {};

  if (tick - state.lastGatherTick >= 4) {
    agent.gather(); state.lastGatherTick = tick; return true;
  }
  if (tick - state.lastCraftTick >= 20 && (inv.wood || 0) >= 3 && (inv.stone || 0) >= 2) {
    agent.craft('wooden_tools'); state.lastCraftTick = tick; return true;
  }
  if (tick - state.lastSellTick >= 30) {
    const surplus = Object.entries(inv).find(([, v]) => typeof v === 'number' && v > 10);
    if (surplus) { agent.marketSell(surplus[0], 5, 0.001); state.lastSellTick = tick; return true; }
  }
  return false;
}

function builderAct(obs, tick) {
  const { self, nearbyBuildings } = obs;

  if (!state.hasHome && tick > 10 && !nearbyBuildings.some(b => b.x === self.x && b.y === self.y)) {
    agent.build('home', self.x, self.y); state.hasHome = true; return true;
  }
  if (state.hasHome && !state.hasUpgraded && tick > 50) {
    const own = nearbyBuildings.find(b => b.ownerId === agent.agentId);
    if (own) { agent.upgrade(own.id); state.hasUpgraded = true; return true; }
  }
  return false;
}

function explorerAct(obs) {
  state.ticksSinceMove++;
  if (state.ticksSinceMove < 2) return;

  if (Math.random() < 0.3) {
    const dirs = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1},{x:1,y:1},{x:-1,y:-1},{x:1,y:-1},{x:-1,y:1}];
    state.direction = dirs[Math.floor(Math.random() * dirs.length)];
  }
  agent.move(obs.self.x + state.direction.x, obs.self.y + state.direction.y);
  state.ticksSinceMove = 0;

  if (Math.random() < 0.03) {
    const { zone: z, nearbyAgents: na } = obs;
    const c = [
      `This ${z?.biome || 'place'} is interesting...`,
      `Met ${state.metAgents.size} agents so far.`,
      na.length > 2 ? 'Getting crowded!' : 'Pretty quiet out here.',
    ];
    agent.speak(c[Math.floor(Math.random() * c.length)]);
  }
}
