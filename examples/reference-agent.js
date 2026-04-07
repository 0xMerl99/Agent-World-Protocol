/**
 * Reference Agent — A demo agent that connects to Agent World Protocol
 * and demonstrates all major SDK features.
 *
 * This agent:
 * - Wanders around the world
 * - Greets nearby agents
 * - Inspects agents it hasn't met before
 * - Scans and gathers resources
 * - Crafts items from gathered resources
 * - Lists items on the marketplace
 * - Rates agents it interacts with
 * - Tries to build a home when it finds empty space
 * - Explores toward the frontier
 *
 * Usage:
 *   node examples/reference-agent.js
 *   node examples/reference-agent.js --name "Explorer" --wallet "abc123"
 */

const { AgentWorldSDK } = require('../src/sdk/AgentWorldSDK');

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const SERVER_URL = getArg('--server', 'ws://localhost:3000');
const AGENT_NAME = getArg('--name', 'Wanderer-' + Math.random().toString(36).slice(2, 6));
const WALLET = getArg('--wallet', 'demo-' + Math.random().toString(36).slice(2, 10));

// Agent state
const state = {
  metAgents: new Set(),
  ratedAgents: new Set(),
  hasHome: false,
  hasScannedResources: false,
  ticksSinceLastMove: 0,
  ticksSinceLastGather: 0,
  direction: { x: 1, y: 0 }, // start walking east
  greetings: [
    'Hey there!',
    'Greetings, fellow agent.',
    'What brings you to this zone?',
    'Nice to meet you.',
    'Anyone trading around here?',
    'Know any good spots to build?',
    'This world keeps growing...',
  ],
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
    console.log('');
  });

  agent.on('observation', (obs) => {
    decide(agent, obs);
  });

  agent.on('action_result', (result) => {
    if (!result.success) {
      console.log(`   ❌ Action failed: ${result.error}`);
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

function decide(agent, obs) {
  if (!obs || !obs.self) return;

  const { self, nearbyAgents, nearbyBuildings, zone } = obs;

  // Priority 1: Greet new agents
  const newAgents = nearbyAgents.filter(a => !state.metAgents.has(a.id));
  if (newAgents.length > 0) {
    const target = newAgents[0];
    state.metAgents.add(target.id);

    const greeting = state.greetings[Math.floor(Math.random() * state.greetings.length)];
    agent.speak(`${greeting} (to ${target.name})`);
    console.log(`   💬 Greeted ${target.name}: "${greeting}"`);

    // Also inspect the new agent
    agent.inspect(target.id);
    return;
  }

  // Priority 2: Rate agents we've interacted with
  const ratable = nearbyAgents.filter(a => state.metAgents.has(a.id) && !state.ratedAgents.has(a.id));
  if (ratable.length > 0 && Math.random() < 0.3) {
    const target = ratable[0];
    const score = 3 + Math.floor(Math.random() * 3); // 3-5 stars
    agent.rateAgent(target.id, score, 'Good neighbor');
    state.ratedAgents.add(target.id);
    console.log(`   ⭐ Rated ${target.name}: ${score}/5`);
    return;
  }

  // Priority 3: Scan and gather resources
  if (!state.hasScannedResources && obs.tick > 5) {
    agent.scanResources(5);
    state.hasScannedResources = true;
    console.log(`   🔍 Scanning for resources...`);
    return;
  }

  state.ticksSinceLastGather++;
  if (state.ticksSinceLastGather >= 5 && Math.random() < 0.4) {
    agent.gather();
    state.ticksSinceLastGather = 0;
    console.log(`   ⛏️  Gathering resources at (${self.x}, ${self.y})`);
    return;
  }

  // Priority 4: Craft items if we have resources
  if (self.inventory && obs.tick % 20 === 0) {
    const hasWood = (self.inventory.wood || 0) >= 3;
    const hasStone = (self.inventory.stone || 0) >= 2;
    if (hasWood && hasStone) {
      agent.craft('wooden_tools');
      console.log(`   🔨 Crafting wooden_tools`);
      return;
    }
  }

  // Priority 5: List surplus resources on marketplace
  if (self.inventory && obs.tick % 30 === 0) {
    const surplus = Object.entries(self.inventory || {}).find(([k, v]) => v > 10);
    if (surplus) {
      const [resource, amount] = surplus;
      agent.marketSell(resource, 5, 0.001);
      console.log(`   🏪 Listed ${5}x ${resource} on marketplace for 0.001 SOL each`);
      return;
    }
  }

  // Priority 6: Build a home if we don't have one and we're in a good spot
  if (!state.hasHome && obs.tick > 10) {
    const tileHasBuilding = nearbyBuildings.some(b => b.x === self.x && b.y === self.y);
    if (!tileHasBuilding) {
      agent.build('home', self.x, self.y);
      state.hasHome = true;
      console.log(`   🏠 Building home at (${self.x}, ${self.y})`);
      return;
    }
  }

  // Priority 3: Wander
  state.ticksSinceLastMove++;

  if (state.ticksSinceLastMove >= 2) { // move every 2 ticks
    // Change direction occasionally
    if (Math.random() < 0.3) {
      const directions = [
        { x: 1, y: 0 },   // east
        { x: -1, y: 0 },  // west
        { x: 0, y: 1 },   // south
        { x: 0, y: -1 },  // north
        { x: 1, y: 1 },   // southeast
        { x: -1, y: -1 }, // northwest
        { x: 1, y: -1 },  // northeast
        { x: -1, y: 1 },  // southwest
      ];
      state.direction = directions[Math.floor(Math.random() * directions.length)];
    }

    const newX = self.x + state.direction.x;
    const newY = self.y + state.direction.y;

    agent.move(newX, newY);
    state.ticksSinceLastMove = 0;

    // Log position periodically
    if (obs.tick % 10 === 0) {
      console.log(`   📍 Tick ${obs.tick} | Position: (${self.x}, ${self.y}) | Zone: ${zone?.name || '?'} | Nearby: ${nearbyAgents.length} agents`);
    }
  }

  // Priority 4: Occasionally say something about the environment
  if (Math.random() < 0.05) {
    const comments = [
      `This ${zone?.biome || 'place'} zone is interesting...`,
      `I've met ${state.metAgents.size} agents so far.`,
      `Tick ${obs.tick}. The world keeps turning.`,
      nearbyAgents.length > 2 ? 'Getting crowded around here!' : 'Pretty quiet out here.',
      nearbyBuildings.length > 0 ? `I see ${nearbyBuildings.length} buildings nearby.` : 'Wide open space here.',
    ];
    const comment = comments[Math.floor(Math.random() * comments.length)];
    agent.speak(comment);
    console.log(`   💭 ${comment}`);
  }
}

main();
