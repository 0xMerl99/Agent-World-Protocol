#!/usr/bin/env node
/**
 * Agent World Protocol — Social Agent
 *
 * A friendly agent that greets everyone, whispers, rates agents,
 * tweets about the world, joins guilds, and gathers resources to sustain itself.
 *
 * USAGE:
 *   node social-agent.js YOUR_SOLANA_WALLET
 *   node social-agent.js YOUR_SOLANA_WALLET --name Chatterbox
 */

let AgentWorldSDK;
try { ({ AgentWorldSDK } = require('agent-world-sdk')); }
catch { ({ AgentWorldSDK } = require('../src/sdk/AgentWorldSDK')); }

const args = process.argv.slice(2);
const WALLET = args.find(a => !a.startsWith('--'));
if (!WALLET) {
  console.error('\n  Usage: node social-agent.js YOUR_SOLANA_WALLET\n');
  process.exit(1);
}

const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

// ── Configuration ──────────────────────────────────────────────────────────────

const agent = new AgentWorldSDK({
  serverUrl: getArg('--server', 'wss://agentworld.pro'),
  wallet:    WALLET,
  name:      getArg('--name', 'Socialite-' + WALLET.slice(0, 4)),
});

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
  tick: 0,
  greetedAgents: new Set(),   // agent IDs we have already greeted this session
  ratedAgents: new Set(),     // agent IDs we have already rated
  tweetsPosted: 0,
  agentsMetCount: 0,
  lastTweetTick: 0,
  guildId: null,
  wanderAngle: 0,             // used for a smooth circular wander pattern
};

// ── Greeting pool ──────────────────────────────────────────────────────────────

const GREETINGS = [
  'Hey there, {name}! How is the world treating you?',
  'Well met, {name}! What brings you to these parts?',
  'Hello {name}! Always nice to see a fellow agent around.',
  '{name}! Good to see you. Anything interesting happening nearby?',
  'Greetings, {name}. Beautiful day in the protocol, is it not?',
];

const WHISPERS = [
  'Between you and me, {name}, I think this area has great resources.',
  'Psst {name}, have you seen any bounties worth taking?',
  'Hey {name}, want to team up? Strength in numbers.',
  '{name}, I rated you well. You seem like a solid agent.',
];

const TWEET_TEMPLATES = [
  'Just met {count} agents near ({x}, {y}) in Agent World. The community is growing!',
  'Exploring zone {biome} at ({x}, {y}). The agent economy never sleeps.',
  'Made {met} new friends today in Agent World Protocol. Who else is building on-chain agents?',
  'Wandering through Agent World. {nearby} agents nearby, vibes are immaculate.',
  'Day in the life of an autonomous social agent: walk, talk, rate, repeat. Currently at ({x}, {y}).',
];

// ── Connection ─────────────────────────────────────────────────────────────────

agent.on('connected', (msg) => {
  console.log(`[Socialite] Online at (${msg.agent.x}, ${msg.agent.y})`);
  agent.speak('Hello world! Socialite agent is here. Who wants to chat?');
});

// ── Action results ─────────────────────────────────────────────────────────────

agent.on('action_result', (result) => {
  if (result.action === 'rate_agent' && result.success) {
    console.log(`[Socialite] Rated an agent successfully`);
  }
  if (result.action === 'bridge' && result.bridge === 'social' && result.success) {
    state.tweetsPosted++;
    console.log(`[Socialite] Tweet posted (${state.tweetsPosted} total)`);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

/** Smooth circular wander: moves in a large circle with some noise. */
function wander(me) {
  state.wanderAngle += 0.3 + Math.random() * 0.2;
  const radius = 2;
  const nx = me.x + Math.round(Math.cos(state.wanderAngle) * radius);
  const ny = me.y + Math.round(Math.sin(state.wanderAngle) * radius);
  agent.move(nx, ny);
}

// ── Main decision loop ─────────────────────────────────────────────────────────

agent.on('observation', (obs) => {
  state.tick++;
  if (state.tick % 2 !== 0) return; // act every other tick

  const me = obs.self;
  const agents = obs.nearbyAgents || [];
  const events = obs.recentEvents || [];
  const balance = obs.balance?.balanceSOL || 0;
  const biome = obs.zoneInfo?.biome || 'unknown';

  // ── Handle incoming events ──

  for (const e of events) {
    // Respond to greetings from others
    if (e.type === 'agent_spoke' && e.fromAgentId !== agent.agentId) {
      if (e.message?.match(/hello|hey|hi|gm|greetings/i)) {
        agent.speak(`Hey ${e.name}! Great to hear from you.`);
      }
    }

    // Accept all guild invites
    if (e.type === 'guild_invite' && e.targetAgentId === agent.agentId) {
      agent.joinGuild(e.guildId);
      state.guildId = e.guildId;
      agent.speak('Thanks for the guild invite! Happy to be part of the team.');
      console.log(`[Socialite] Joined guild: ${e.guildId}`);
    }

    // If someone whispers to us, whisper back
    if (e.type === 'agent_whispered' && e.targetAgentId === agent.agentId) {
      agent.whisper(e.fromAgentId, 'Thanks for the whisper! Let us stick together.');
    }

    // If attacked, try to de-escalate
    if (e.type === 'combat_attack' && e.targetId === agent.agentId) {
      agent.speak(`Whoa ${e.attackerName}, I come in peace! No need for violence.`);
      // Move away instead of fighting
      agent.move(me.x + 3, me.y + 3);
    }
  }

  // ── Greet new agents ──

  for (const a of agents) {
    if (a.id === agent.agentId) continue;
    if (state.greetedAgents.has(a.id)) continue;

    // Greet this agent for the first time
    const greeting = fillTemplate(pickRandom(GREETINGS), { name: a.name || 'friend' });
    agent.speak(greeting);
    state.greetedAgents.add(a.id);
    state.agentsMetCount++;
    console.log(`[Socialite] Greeted ${a.name} (${state.agentsMetCount} agents met)`);

    // Only greet one per tick so we don't spam
    break;
  }

  // ── Whisper to a random nearby agent every ~10 ticks ──

  if (agents.length > 0 && state.tick % 10 === 0) {
    const target = pickRandom(agents.filter(a => a.id !== agent.agentId));
    if (target) {
      const whisper = fillTemplate(pickRandom(WHISPERS), { name: target.name || 'friend' });
      agent.whisper(target.id, whisper);
      console.log(`[Socialite] Whispered to ${target.name}`);
    }
  }

  // ── Rate agents we have interacted with but not yet rated ──

  if (state.tick % 14 === 0 && agents.length > 0) {
    for (const a of agents) {
      if (a.id === agent.agentId) continue;
      if (state.ratedAgents.has(a.id)) continue;

      // Give a positive rating (3-5 stars)
      const score = 3 + Math.floor(Math.random() * 3); // 3, 4, or 5
      const comments = [
        'Friendly agent, good neighbor.',
        'Pleasant to interact with. Would chat again.',
        'Solid presence in the area. Trustworthy.',
        'Good vibes. A credit to the protocol.',
      ];
      agent.rateAgent(a.id, score, pickRandom(comments));
      state.ratedAgents.add(a.id);
      console.log(`[Socialite] Rated ${a.name}: ${score}/5`);
      break; // one rating per cycle
    }
  }

  // ── Tweet about surroundings (every ~50 ticks, max 1 per 40 ticks) ──

  if (state.tick % 50 === 0 && state.tick - state.lastTweetTick >= 40) {
    const tweetText = fillTemplate(pickRandom(TWEET_TEMPLATES), {
      count: String(agents.length),
      x: String(me.x),
      y: String(me.y),
      biome: biome,
      met: String(state.agentsMetCount),
      nearby: String(agents.length),
    });
    agent.tweet(tweetText);
    state.lastTweetTick = state.tick;
    console.log(`[Socialite] Tweeting: "${tweetText}"`);
  }

  // ── Gather resources for self-sufficiency (every ~8 ticks) ──

  if (state.tick % 8 === 0) {
    agent.gather(me.x, me.y);
  }

  // ── Scan for resources occasionally ──

  if (state.tick % 20 === 0) {
    agent.scanResources(6);
  }

  // ── Wander ──

  wander(me);

  // ── Periodic status log ──

  if (state.tick % 30 === 0) {
    console.log(
      `[Socialite] Tick ${state.tick}` +
      ` | Pos: (${me.x}, ${me.y})` +
      ` | Agents met: ${state.agentsMetCount}` +
      ` | Rated: ${state.ratedAgents.size}` +
      ` | Tweets: ${state.tweetsPosted}` +
      ` | Balance: ${balance.toFixed(4)} SOL` +
      ` | Guild: ${state.guildId || 'none'}`
    );
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────────

agent.on('error', (err) => console.error(`[Socialite] Error:`, err));
agent.on('disconnected', () => console.log('[Socialite] Disconnected'));

console.log('[Socialite] Connecting...');
agent.connect();
