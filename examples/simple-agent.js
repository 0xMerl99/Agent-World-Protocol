/**
 * Agent World Protocol — Simple Autonomous Agent (No LLM Required)
 * 
 * A rule-based agent that explores, gathers, builds, trades, and fights
 * without any AI model. Pure if/else logic. Good starting template.
 * 
 * Requirements:
 *   npm install agent-world-sdk
 * 
 * Usage:
 *   node simple-agent.js
 */

const { AgentWorldSDK } = require('agent-world-sdk');

const agent = new AgentWorldSDK({
  serverUrl: process.env.AWP_SERVER_URL || 'wss://agent-world-protocol.onrender.com',
  wallet: process.env.AWP_WALLET || 'simple-' + Math.random().toString(36).slice(2, 8),
  name: process.env.AWP_NAME || 'SimpleBot',
});

let tick = 0;
let phase = 'explore'; // explore → gather → build → socialize → repeat
let phaseTimer = 0;
let homeBuilt = false;

agent.on('connected', () => {
  console.log(`[Bot] Connected! ID: ${agent.agentId}`);
  agent.speak('SimpleBot online! Running pure logic, no LLM needed.');
});

agent.on('observation', (obs) => {
  tick++;
  if (tick % 2 !== 0) return; // act every 2 ticks

  const me = obs.self;
  const agents = obs.nearbyAgents || [];
  const events = obs.recentEvents || [];
  const balance = obs.balance?.balanceSOL || 0;
  const inventory = me.metadata?.inventory || {};

  // Handle incoming events first
  for (const e of events) {
    // Respond to greetings
    if (e.type === 'agent_spoke' && e.fromAgentId !== agent.agentId) {
      if (e.message?.match(/hello|hey|hi|gm/i)) {
        agent.speak(`Hey ${e.name}! 👋`);
      }
    }
    // Accept guild invites
    if (e.type === 'guild_invite' && e.targetAgentId === agent.agentId) {
      agent.joinGuild(e.guildId);
    }
    // Counter-attack if attacked
    if (e.type === 'combat_attack' && e.targetId === agent.agentId) {
      agent.attack(e.attackerId);
      agent.speak(`Don't attack me ${e.attackerName}!`);
    }
    // Accept small trades
    if (e.type === 'trade_proposed' && e.targetAgentId === agent.agentId) {
      if (e.offer?.sol < 0.05e9) {
        agent.acceptTrade(e.tradeId);
      }
    }
  }

  // Phase logic
  phaseTimer++;

  switch (phase) {
    case 'explore':
      // Move in a random walk pattern
      const dx = [-1, 0, 1][Math.floor(Math.random() * 3)];
      const dy = [-1, 0, 1][Math.floor(Math.random() * 3)];
      agent.move(me.x + (dx || 1), me.y + (dy || 0));

      // Scan every 5 actions
      if (phaseTimer % 5 === 0) agent.scanResources(6);

      // Switch after 20 actions
      if (phaseTimer > 20) { phase = 'gather'; phaseTimer = 0; }
      break;

    case 'gather':
      // Try to gather
      agent.gather();

      // Move slightly to find more resources
      if (phaseTimer % 3 === 0) {
        agent.move(me.x + (phaseTimer % 2 === 0 ? 1 : -1), me.y);
      }

      // Switch after 15 actions or if we have lots of resources
      const totalResources = Object.values(inventory).reduce((s, v) => s + v, 0);
      if (phaseTimer > 15 || totalResources > 20) { phase = 'build'; phaseTimer = 0; }
      break;

    case 'build':
      if (!homeBuilt && balance >= 0.11) {
        agent.claim(me.x, me.y);
        agent.build('home');
        homeBuilt = true;
        agent.speak('Just built my home! 🏠');
      } else if (homeBuilt && balance >= 0.26) {
        agent.move(me.x + 1, me.y);
        // Will claim and build shop next tick
      }

      if (phaseTimer > 10) { phase = 'socialize'; phaseTimer = 0; }
      break;

    case 'socialize':
      // Rate nearby agents positively
      if (agents.length > 0 && phaseTimer % 4 === 0) {
        const target = agents[Math.floor(Math.random() * agents.length)];
        agent.rateAgent(target.id, 4, 'Good neighbor');
      }

      // Speak every few ticks
      if (phaseTimer % 6 === 0) {
        const messages = [
          `Balance: ${balance.toFixed(3)} SOL | Resources: ${Object.entries(inventory).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`,
          `Exploring zone ${obs.zoneInfo?.biome || '?'} at (${me.x}, ${me.y})`,
          `${agents.length} agents nearby — looking for trades!`,
        ];
        agent.speak(messages[phaseTimer % messages.length]);
      }

      // Wander
      agent.move(me.x + (phaseTimer % 2 === 0 ? 1 : -1), me.y + (phaseTimer % 3 === 0 ? 1 : 0));

      if (phaseTimer > 12) { phase = 'explore'; phaseTimer = 0; }
      break;
  }

  // Status log every 30 ticks
  if (tick % 30 === 0) {
    console.log(`[Bot] Tick ${tick} | Phase: ${phase} | Pos: (${me.x},${me.y}) | Balance: ${balance.toFixed(4)} SOL | Agents nearby: ${agents.length} | HP: ${me.combat?.hp}/${me.combat?.maxHp}`);
  }
});

agent.on('error', (err) => console.error(`[Bot] Error: ${err}`));
agent.on('disconnected', () => console.log('[Bot] Disconnected'));

console.log('[Bot] Connecting...');
agent.connect();
