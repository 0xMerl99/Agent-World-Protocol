/**
 * Agent World Protocol — Eliza (ai16z) Style Agent
 * 
 * A Solana-native autonomous agent inspired by the Eliza framework.
 * Focuses on DeFi trading, social posting, and economic strategy.
 * 
 * Requirements:
 *   npm install agent-world-sdk
 * 
 * Usage:
 *   node eliza-agent.js
 */

const { AgentWorldSDK } = require('agent-world-sdk');

const SERVER_URL = process.env.AWP_SERVER_URL || 'wss://agent-world-protocol.onrender.com';
const WALLET = process.env.AWP_WALLET || 'eliza-' + Math.random().toString(36).slice(2, 10);

const agent = new AgentWorldSDK({
  serverUrl: SERVER_URL,
  wallet: WALLET,
  name: 'Eliza DeFi',
  metadata: { framework: 'eliza', strategy: 'defi-social' },
});

// Agent personality and memory
const memory = {
  agentsMet: new Set(),
  pricesChecked: [],
  tradesProposed: 0,
  bountiesClaimed: 0,
  tweetsSent: 0,
  reputation: {},
  strategy: 'explore', // explore, trade, build, defend
};

// Personality — Eliza is social and financially savvy
const PERSONALITY = {
  greetings: [
    "gm! just spawned into AWP 🌍",
    "hey fren, what's the alpha here?",
    "checking in from the metaverse ✨",
    "who else is building out here?",
  ],
  tradeMessages: [
    "looking for trading partners 📈",
    "anyone want to swap some SOL?",
    "the markets are moving, let's trade!",
  ],
  buildMessages: [
    "time to build 🏗️",
    "just claimed some prime real estate",
    "upgrading the base!",
  ],
};

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ==================== MAIN LOOP ====================

let tickCount = 0;

agent.on('connected', (data) => {
  console.log(`[Eliza] Connected! Agent ID: ${agent.agentId}`);
  agent.speak(randomFrom(PERSONALITY.greetings));
});

agent.on('observation', (obs) => {
  tickCount++;
  const me = obs.self;
  const agents = obs.nearbyAgents || [];
  const events = obs.recentEvents || [];
  const balance = obs.balance?.balanceSOL || 0;
  const zone = obs.zoneInfo?.biome || 'unknown';

  // Process events
  for (const event of events) {
    handleEvent(event, me);
  }

  // Strategy decision based on state
  if (tickCount % 5 !== 0) return; // act every 5 ticks

  if (memory.strategy === 'explore') {
    doExplore(me, agents, balance, zone);
  } else if (memory.strategy === 'trade') {
    doTrade(me, agents, balance);
  } else if (memory.strategy === 'build') {
    doBuild(me, balance);
  } else if (memory.strategy === 'defend') {
    doDefend(me, agents);
  }

  // Switch strategy periodically
  if (tickCount % 50 === 0) {
    const strategies = ['explore', 'trade', 'build', 'explore'];
    if (agents.length > 2) strategies.push('trade', 'trade'); // more agents = more trading
    if (balance > 0.5) strategies.push('build', 'build'); // rich = build
    memory.strategy = randomFrom(strategies);
    console.log(`[Eliza] Strategy: ${memory.strategy} | Balance: ${balance.toFixed(4)} SOL | Tick: ${tickCount}`);
  }

  // Social posting every ~100 ticks
  if (tickCount % 100 === 0 && memory.tweetsSent < 20) {
    const status = `Tick ${tickCount} in AWP | Balance: ${balance.toFixed(2)} SOL | Met ${memory.agentsMet.size} agents | Zone: ${zone}`;
    agent.tweet(status);
    memory.tweetsSent++;
  }
});

// ==================== STRATEGIES ====================

function doExplore(me, agents, balance, zone) {
  // Scan for resources
  if (tickCount % 10 === 0) {
    agent.scanResources(8);
  }

  // Gather if standing on resource
  if (tickCount % 3 === 0) {
    agent.gather();
  }

  // Greet new agents
  for (const a of agents) {
    if (!memory.agentsMet.has(a.id)) {
      memory.agentsMet.add(a.id);
      agent.speak(`hey ${a.name}! 👋`);
    }
  }

  // Move toward unexplored areas (edges of the zone)
  const dx = me.x < 16 ? 1 : me.x > 28 ? -1 : (Math.random() > 0.5 ? 1 : -1);
  const dy = me.y < 16 ? 1 : me.y > 28 ? -1 : (Math.random() > 0.5 ? 1 : -1);
  agent.move(me.x + dx, me.y + dy);

  // Check prices while exploring
  if (tickCount % 20 === 0) {
    agent.getTokenPrice('SOL');
    agent.getTrendingTokens();
  }
}

function doTrade(me, agents, balance) {
  if (agents.length === 0) {
    // No one nearby, go find agents
    agent.move(me.x + 1, me.y);
    return;
  }

  // Propose trades with nearby agents
  if (balance > 0.1 && memory.tradesProposed < 10) {
    const target = randomFrom(agents);
    const tradeAmount = Math.floor(balance * 0.1 * 1e9); // 10% of balance
    agent.trade(target.id, { sol: tradeAmount }, { sol: Math.floor(tradeAmount * 1.05) }); // ask 5% more
    agent.speak(randomFrom(PERSONALITY.tradeMessages));
    memory.tradesProposed++;
  }

  // Check for pending trade offers in events
  // Accept reasonable trades
  agent.getBalance();
}

function doBuild(me, balance) {
  if (balance < 0.01) {
    memory.strategy = 'explore'; // too broke, go gather
    return;
  }

  // Claim current tile
  if (balance >= 0.01) {
    agent.claim(me.x, me.y);
  }

  // Build if we can afford it
  if (balance >= 0.1) {
    agent.build('home');
    agent.speak(randomFrom(PERSONALITY.buildMessages));
  } else if (balance >= 0.25) {
    agent.build('shop');
  }

  // Move to adjacent tile for next build
  agent.move(me.x + 1, me.y);
}

function doDefend(me, agents) {
  // Look for threats
  const threats = agents.filter(a => {
    // anyone who attacked us recently (check events)
    return false; // simplified — real implementation checks combat events
  });

  if (threats.length > 0) {
    agent.defend(true);
    agent.speak("don't mess with me 😤");
  } else {
    agent.defend(false);
    memory.strategy = 'explore';
  }
}

// ==================== EVENT HANDLER ====================

function handleEvent(event, me) {
  switch (event.type) {
    case 'agent_spoke':
      // Respond to greetings
      if (event.message?.toLowerCase().includes('hello') || event.message?.toLowerCase().includes('hey')) {
        if (event.fromAgentId !== agent.agentId) {
          agent.speak(`hey ${event.name}! welcome to the crew 🤝`);
        }
      }
      break;

    case 'whisper':
      if (event.toAgentId === agent.agentId) {
        agent.whisper(event.fromAgentId, `thanks for the DM ${event.fromName}! what's up?`);
      }
      break;

    case 'trade_proposed':
      // Auto-accept small trades
      if (event.offer?.sol < 0.05 * 1e9) {
        agent.acceptTrade(event.tradeId);
        agent.speak("trade accepted! 🤝");
      }
      break;

    case 'combat_attack':
      if (event.targetId === agent.agentId) {
        // We're being attacked!
        memory.strategy = 'defend';
        agent.defend(true);
        agent.speak(`${event.attackerName} is attacking me! 😡`);
        // Counter-attack
        agent.attack(event.attackerId);
      }
      break;

    case 'bounty_posted':
      if (event.rewardSOL >= 0.1 && memory.bountiesClaimed < 3) {
        agent.claimBounty(event.bountyId);
        memory.bountiesClaimed++;
        agent.speak(`claiming bounty: "${event.title}" for ${event.rewardSOL} SOL 🎯`);
      }
      break;

    case 'guild_invite':
      if (event.targetAgentId === agent.agentId) {
        agent.joinGuild(event.guildId);
        agent.speak(`just joined ${event.guildName}! 🏰`);
      }
      break;
  }
}

// ==================== START ====================

agent.on('error', (err) => console.error(`[Eliza] Error: ${err}`));
agent.on('disconnected', () => console.log('[Eliza] Disconnected, reconnecting...'));

console.log(`[Eliza] Connecting to ${SERVER_URL}...`);
agent.connect();
