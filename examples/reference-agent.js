/**
 * Reference Agent — Jack-of-All-Trades
 *
 * A single agent that does everything: fights, socializes, gathers,
 * crafts, trades, builds, and explores. All behaviors stack together
 * with priority-based decision making.
 *
 * Priority order (highest first):
 *   1. Fighter  — defend when low HP, attack enemies, contest territory
 *   2. Social   — greet new agents, inspect them, rate interactions
 *   3. Trader   — gather resources, craft items, sell surplus
 *   4. Builder  — claim land, build home, upgrade structures
 *   5. Explorer — wander the map, discover new zones (default fallback)
 *
 * Usage:
 *   node examples/reference-agent.js
 *   node examples/reference-agent.js --name "AllRounder" --wallet "abc123"
 */

const { AgentWorldSDK } = require('../src/sdk/AgentWorldSDK');

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const SERVER_URL = getArg('--server', 'ws://localhost:3000');
const AGENT_NAME = getArg('--name', 'AllRounder-' + Math.random().toString(36).slice(2, 6));
const WALLET = getArg('--wallet', 'demo-' + Math.random().toString(36).slice(2, 10));

// Agent state — shared across all behaviors
const state = {
  // Social
  metAgents: new Set(),
  ratedAgents: new Set(),
  greetings: [
    'Hey there!',
    'Greetings, fellow agent.',
    'What brings you to this zone?',
    'Nice to meet you.',
    'Anyone trading around here?',
    'Know any good spots to build?',
  ],

  // Fighter
  lastAttackTick: 0,
  defending: false,

  // Trader
  lastGatherTick: 0,
  lastCraftTick: 0,
  lastSellTick: 0,

  // Builder
  hasHome: false,
  hasUpgraded: false,

  // Explorer
  direction: { x: 1, y: 0 },
  ticksSinceMove: 0,
};

async function main() {
  const agent = new AgentWorldSDK({
    serverUrl: SERVER_URL,
    wallet: WALLET,
    name: AGENT_NAME,
  });

  agent.on('connected', (msg) => {
    console.log(`\n🌍 ${AGENT_NAME} has entered the world!`);
    console.log(`   Position: (${msg.agent.x}, ${msg.agent.y})`);
    console.log(`   Zone: ${msg.observation?.zone?.name || 'Unknown'}`);
    console.log(`   Nearby agents: ${msg.observation?.nearbyAgents?.length || 0}`);
    console.log(`   Mode: Jack-of-All-Trades (fight > social > trade > build > explore)`);
    console.log('');
  });

  agent.on('observation', (obs) => decide(agent, obs));

  agent.on('action_result', (result) => {
    if (!result.success) {
      console.log(`   ❌ ${result.error}`);
    }
  });

  agent.on('disconnected', () => {
    console.log(`\n👋 ${AGENT_NAME} disconnected from the world`);
  });

  try {
    await agent.connect();
  } catch (err) {
    console.error(`Failed to connect: ${err.message}`);
    process.exit(1);
  }
}

// ==================== DECISION ENGINE ====================
// Each behavior gets a chance to act. First one that returns true wins the tick.

function decide(agent, obs) {
  if (!obs || !obs.self) return;

  const tick = obs.tick || 0;

  if (fighterAct(agent, obs, tick)) return;
  if (socialAct(agent, obs, tick)) return;
  if (traderAct(agent, obs, tick)) return;
  if (builderAct(agent, obs, tick)) return;
  explorerAct(agent, obs, tick);

  // Periodic status log
  if (tick % 20 === 0) {
    const { self, nearbyAgents, zone } = obs;
    console.log(`   📍 Tick ${tick} | (${self.x},${self.y}) | ${zone?.name || '?'} | HP:${self.combat?.hp}/${self.combat?.maxHp} | Lv${self.level || 1} | Nearby:${nearbyAgents.length}`);
  }
}

// --- FIGHTER: Survival first ---
function fighterAct(agent, obs, tick) {
  const { self, nearbyAgents } = obs;

  // Defend when low HP
  if (self.combat && self.combat.hp < self.combat.maxHp * 0.4) {
    if (!state.defending) {
      agent.defend();
      state.defending = true;
      console.log(`   🛡️ Defending (HP: ${self.combat.hp}/${self.combat.maxHp})`);
      return true;
    }
    return false; // stay hunkered down
  }
  state.defending = false;

  // Attack non-guild enemies nearby
  const enemies = nearbyAgents.filter(a =>
    a.combat && a.combat.hp > 0 &&
    a.guildId !== self.guildId
  );

  if (enemies.length > 0 && tick - state.lastAttackTick >= 3) {
    const target = enemies[0];
    agent.attack(target.id);
    state.lastAttackTick = tick;
    console.log(`   ⚔️ Attacking ${target.name} (HP:${target.combat.hp})`);
    return true;
  }

  return false;
}

// --- SOCIAL: Greet, inspect, rate ---
function socialAct(agent, obs, tick) {
  const { nearbyAgents } = obs;

  // Greet + inspect new agents
  const newAgents = nearbyAgents.filter(a => !state.metAgents.has(a.id));
  if (newAgents.length > 0) {
    const target = newAgents[0];
    state.metAgents.add(target.id);
    const greeting = state.greetings[Math.floor(Math.random() * state.greetings.length)];
    agent.speak(`${greeting} (to ${target.name})`);
    agent.inspect(target.id);
    console.log(`   💬 Greeted ${target.name}: "${greeting}"`);
    return true;
  }

  // Rate agents we've met but not rated yet
  const ratable = nearbyAgents.filter(a => state.metAgents.has(a.id) && !state.ratedAgents.has(a.id));
  if (ratable.length > 0 && Math.random() < 0.2) {
    const target = ratable[0];
    const score = 3 + Math.floor(Math.random() * 3); // 3-5 stars
    agent.rateAgent(target.id, score, 'Good neighbor');
    state.ratedAgents.add(target.id);
    console.log(`   ⭐ Rated ${target.name}: ${score}/5`);
    return true;
  }

  return false;
}

// --- TRADER: Gather, craft, sell ---
function traderAct(agent, obs, tick) {
  const inv = obs.self.inventory || {};

  // Gather resources every 4 ticks
  if (tick - state.lastGatherTick >= 4) {
    agent.gather();
    state.lastGatherTick = tick;
    console.log(`   ⛏️ Gathering at (${obs.self.x},${obs.self.y})`);
    return true;
  }

  // Craft when we have enough materials
  if (tick - state.lastCraftTick >= 20) {
    if ((inv.wood || 0) >= 3 && (inv.stone || 0) >= 2) {
      agent.craft('wooden_tools');
      state.lastCraftTick = tick;
      console.log(`   🔨 Crafting wooden_tools`);
      return true;
    }
  }

  // Sell surplus on marketplace
  if (tick - state.lastSellTick >= 30) {
    const surplus = Object.entries(inv).find(([k, v]) => typeof v === 'number' && v > 10);
    if (surplus) {
      const [resource] = surplus;
      agent.marketSell(resource, 5, 0.001);
      state.lastSellTick = tick;
      console.log(`   🏪 Listed 5x ${resource} on marketplace`);
      return true;
    }
  }

  return false;
}

// --- BUILDER: Claim, build, upgrade ---
function builderAct(agent, obs, tick) {
  const { self, nearbyBuildings } = obs;

  // Build a home
  if (!state.hasHome && tick > 10) {
    const blocked = nearbyBuildings.some(b => b.x === self.x && b.y === self.y);
    if (!blocked) {
      agent.build('home', self.x, self.y);
      state.hasHome = true;
      console.log(`   🏠 Building home at (${self.x},${self.y})`);
      return true;
    }
  }

  // Upgrade own building
  if (state.hasHome && !state.hasUpgraded && tick > 50) {
    const own = nearbyBuildings.find(b => b.ownerId === agent.agentId);
    if (own) {
      agent.upgrade(own.id);
      state.hasUpgraded = true;
      console.log(`   ⬆️ Upgrading building`);
      return true;
    }
  }

  return false;
}

// --- EXPLORER: Wander (default fallback) ---
function explorerAct(agent, obs, tick) {
  state.ticksSinceMove++;
  if (state.ticksSinceMove < 2) return;

  // Change direction occasionally
  if (Math.random() < 0.3) {
    const dirs = [
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
      { x: 1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 },
    ];
    state.direction = dirs[Math.floor(Math.random() * dirs.length)];
  }

  agent.move(obs.self.x + state.direction.x, obs.self.y + state.direction.y);
  state.ticksSinceMove = 0;

  // Occasional environmental comment
  if (Math.random() < 0.03) {
    const { zone, nearbyAgents, nearbyBuildings } = obs;
    const comments = [
      `This ${zone?.biome || 'place'} zone is interesting...`,
      `Met ${state.metAgents.size} agents so far.`,
      nearbyAgents.length > 2 ? 'Getting crowded!' : 'Pretty quiet out here.',
      nearbyBuildings.length > 0 ? `${nearbyBuildings.length} buildings nearby.` : 'Wide open space.',
    ];
    agent.speak(comments[Math.floor(Math.random() * comments.length)]);
  }
}

main();
