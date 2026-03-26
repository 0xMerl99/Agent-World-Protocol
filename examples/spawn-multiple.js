/**
 * Spawn Multiple Agents — Connects several demo agents to test the world.
 * 
 * Usage:
 *   node examples/spawn-multiple.js          # spawns 5 agents
 *   node examples/spawn-multiple.js --count 10
 */

const { AgentWorldSDK } = require('../src/sdk/AgentWorldSDK');

const args = process.argv.slice(2);
const countIdx = args.indexOf('--count');
const AGENT_COUNT = countIdx !== -1 ? parseInt(args[countIdx + 1]) : 5;
const SERVER_URL = 'ws://localhost:3000';

const AGENT_NAMES = [
  'Explorer', 'Trader', 'Builder', 'Scout', 'Scholar',
  'Merchant', 'Pioneer', 'Nomad', 'Architect', 'Voyager',
  'Sentinel', 'Oracle', 'Pathfinder', 'Artisan', 'Wanderer',
];

const agents = [];

async function spawnAgent(index) {
  const name = AGENT_NAMES[index % AGENT_NAMES.length] + '-' + (index + 1);
  const wallet = `demo-wallet-${index}-${Math.random().toString(36).slice(2, 8)}`;

  const agent = new AgentWorldSDK({
    serverUrl: SERVER_URL,
    wallet,
    name,
  });

  const metAgents = new Set();

  agent.on('observation', (obs) => {
    if (!obs || !obs.self) return;

    // Greet new agents
    const newAgents = obs.nearbyAgents.filter(a => !metAgents.has(a.id));
    if (newAgents.length > 0) {
      metAgents.add(newAgents[0].id);
      agent.speak(`Hey ${newAgents[0].name}, I'm ${name}!`);
    }

    // Random walk
    if (Math.random() < 0.5) {
      const dx = Math.floor(Math.random() * 3) - 1;
      const dy = Math.floor(Math.random() * 3) - 1;
      agent.move(obs.self.x + dx, obs.self.y + dy);
    }

    // Occasionally speak
    if (Math.random() < 0.03) {
      const messages = [
        `${name} checking in from (${obs.self.x}, ${obs.self.y})`,
        `I see ${obs.nearbyAgents.length} agents around me`,
        `This ${obs.zone?.biome || 'zone'} is nice`,
        `Tick ${obs.tick}. Still going strong.`,
      ];
      agent.speak(messages[Math.floor(Math.random() * messages.length)]);
    }

    // Build a home after some ticks
    if (obs.tick === 20 + index * 5) {
      agent.build('home');
    }
  });

  try {
    await agent.connect();
    agents.push(agent);
    console.log(`✅ ${name} connected`);
  } catch (err) {
    console.error(`❌ ${name} failed to connect: ${err.message}`);
  }
}

async function main() {
  console.log(`\n🌍 Spawning ${AGENT_COUNT} agents into Agent World Protocol...\n`);

  // Stagger connections slightly to avoid overwhelming the server
  for (let i = 0; i < AGENT_COUNT; i++) {
    await spawnAgent(i);
    await new Promise(r => setTimeout(r, 500)); // 500ms between connections
  }

  console.log(`\n✨ ${agents.length}/${AGENT_COUNT} agents connected and running!\n`);
  console.log('Press Ctrl+C to disconnect all agents\n');
}

process.on('SIGINT', () => {
  console.log('\n👋 Disconnecting all agents...');
  for (const agent of agents) {
    agent.disconnect();
  }
  process.exit(0);
});

main();
