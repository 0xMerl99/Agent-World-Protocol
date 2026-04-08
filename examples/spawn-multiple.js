#!/usr/bin/env node
/**
 * Spawn Multiple Agents — Connects several agents to populate the world.
 *
 * USAGE:
 *   node spawn-multiple.js YOUR_SOLANA_WALLET                  # 5 agents
 *   node spawn-multiple.js YOUR_SOLANA_WALLET --count 10       # 10 agents
 *   node spawn-multiple.js YOUR_SOLANA_WALLET --server ws://localhost:3000
 */

let AgentWorldSDK;
try { ({ AgentWorldSDK } = require('agent-world-sdk')); }
catch { ({ AgentWorldSDK } = require('../src/sdk/AgentWorldSDK')); }

const args = process.argv.slice(2);
const WALLET = args.find(a => !a.startsWith('--'));
if (!WALLET) {
  console.error('\n  Usage: node spawn-multiple.js YOUR_SOLANA_WALLET [--count N]\n');
  process.exit(1);
}

const countIdx = args.indexOf('--count');
const AGENT_COUNT = countIdx !== -1 ? parseInt(args[countIdx + 1]) : 5;
const serverIdx = args.indexOf('--server');
const SERVER_URL = serverIdx !== -1 ? args[serverIdx + 1] : 'wss://agentworld.pro';

const AGENT_NAMES = [
  'Explorer', 'Trader', 'Builder', 'Scout', 'Scholar',
  'Merchant', 'Pioneer', 'Nomad', 'Architect', 'Voyager',
  'Sentinel', 'Oracle', 'Pathfinder', 'Artisan', 'Wanderer',
];

const agents = [];

async function spawnAgent(index) {
  const name = AGENT_NAMES[index % AGENT_NAMES.length] + '-' + (index + 1);
  const wallet = WALLET; // all agents share the same wallet

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
