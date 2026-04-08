#!/usr/bin/env node
/**
 * Agent World Protocol — Territory Defender Agent
 *
 * Claims land around spawn, builds a fortified base, creates a guild,
 * and aggressively guards territory. Intruders get warned then attacked.
 *
 * USAGE:
 *   node territory-defender-agent.js YOUR_SOLANA_WALLET
 *   node territory-defender-agent.js YOUR_SOLANA_WALLET --name Fortress
 */

let AgentWorldSDK;
try { ({ AgentWorldSDK } = require('agent-world-sdk')); }
catch { ({ AgentWorldSDK } = require('../src/sdk/AgentWorldSDK')); }

const args = process.argv.slice(2);
const WALLET = args.find(a => !a.startsWith('--'));
if (!WALLET) {
  console.error('\n  Usage: node territory-defender-agent.js YOUR_SOLANA_WALLET\n');
  process.exit(1);
}

const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

// ── Configuration ──────────────────────────────────────────────────────────────

const TERRITORY_RADIUS = 3;
const WARNING_DISTANCE = 5;
const ATTACK_DISTANCE  = 3;

const agent = new AgentWorldSDK({
  serverUrl: getArg('--server', 'wss://agentworld.pro'),
  wallet:    WALLET,
  name:      getArg('--name', 'Sentinel-' + WALLET.slice(0, 4)),
});

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
  tick: 0,
  phase: 'claim',        // claim | build | patrol | recruit
  phaseTimer: 0,
  spawnX: 0,
  spawnY: 0,
  claimedTiles: 0,
  claimQueue: [],         // list of {x, y} tiles left to claim
  homeBuilt: false,
  hqBuilt: false,
  guildCreated: false,
  guildId: null,
  guildMembers: new Set(),
  warnedAgents: new Set(), // agent IDs that have been warned once
  patrolIndex: 0,
  defendActive: false,
};

// ── Connection ─────────────────────────────────────────────────────────────────

agent.on('connected', (msg) => {
  state.spawnX = msg.agent.x;
  state.spawnY = msg.agent.y;

  // Pre-compute the list of tiles to claim in a spiral-ish order
  buildClaimQueue(state.spawnX, state.spawnY);

  console.log(`[Sentinel] Online at (${msg.agent.x}, ${msg.agent.y})`);
  agent.speak('This territory is now under my protection. Trespassers will be dealt with.');
  agent.defend(true);
  state.defendActive = true;
});

// ── Action results ─────────────────────────────────────────────────────────────

agent.on('action_result', (result) => {
  if (result.action === 'claim' && result.success) {
    state.claimedTiles++;
    console.log(`[Sentinel] Claimed tile (${state.claimedTiles} total)`);
  }
  if (result.action === 'build' && result.success) {
    console.log(`[Sentinel] Built: ${result.buildingType || 'structure'}`);
  }
  if (result.action === 'create_guild' && result.success) {
    state.guildCreated = true;
    state.guildId = result.guildId;
    console.log(`[Sentinel] Guild created: ${state.guildId}`);
    agent.speak('The Sentinels guild is open. Friendly agents are welcome to join.');
  }
  if (result.action === 'guild_invite' && result.success) {
    console.log(`[Sentinel] Guild invite sent`);
  }
  if (result.action === 'attack' && result.success) {
    console.log(`[Sentinel] Attack landed on intruder`);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a list of tiles to claim around the center, sorted by distance. */
function buildClaimQueue(cx, cy) {
  const tiles = [];
  for (let dx = -TERRITORY_RADIUS; dx <= TERRITORY_RADIUS; dx++) {
    for (let dy = -TERRITORY_RADIUS; dy <= TERRITORY_RADIUS; dy++) {
      tiles.push({ x: cx + dx, y: cy + dy, dist: Math.abs(dx) + Math.abs(dy) });
    }
  }
  // Claim center first, then expand outward
  tiles.sort((a, b) => a.dist - b.dist);
  state.claimQueue = tiles;
}

/** Manhattan distance between two points. */
function dist(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** Generate patrol waypoints around the territory perimeter. */
function getPatrolPoints() {
  const r = TERRITORY_RADIUS;
  const cx = state.spawnX;
  const cy = state.spawnY;
  return [
    { x: cx - r, y: cy - r },
    { x: cx + r, y: cy - r },
    { x: cx + r, y: cy + r },
    { x: cx - r, y: cy + r },
  ];
}

// ── Main decision loop ─────────────────────────────────────────────────────────

agent.on('observation', (obs) => {
  state.tick++;
  if (state.tick % 2 !== 0) return; // act every other tick

  const me = obs.self;
  const agents = obs.nearbyAgents || [];
  const events = obs.recentEvents || [];
  const balance = obs.balance?.balanceSOL || 0;

  state.phaseTimer++;

  // ── Handle incoming events ──

  for (const e of events) {
    // Accept guild invites from others too
    if (e.type === 'guild_invite' && e.targetAgentId === agent.agentId) {
      // Only join if we have not created our own guild
      if (!state.guildCreated) {
        agent.joinGuild(e.guildId);
      }
    }
    // Counter-attack if hit
    if (e.type === 'combat_attack' && e.targetId === agent.agentId) {
      agent.attack(e.attackerId);
      agent.speak(`You dare attack me, ${e.attackerName}? Defending my territory!`);
    }
  }

  // ── Threat detection (runs every phase) ──

  for (const a of agents) {
    if (a.id === agent.agentId) continue;

    // Skip guild members
    if (state.guildMembers.has(a.id)) continue;
    if (a.guildId && state.guildId && a.guildId === state.guildId) {
      state.guildMembers.add(a.id);
      continue;
    }

    const d = dist(a.x, a.y, state.spawnX, state.spawnY);

    // Inside attack range — attack
    if (d <= ATTACK_DISTANCE) {
      if (!state.warnedAgents.has(a.id)) {
        agent.whisper(a.id, 'FINAL WARNING: Leave my territory immediately or face consequences.');
        state.warnedAgents.add(a.id);
      } else {
        agent.attack(a.id);
        agent.speak(`Intruder ${a.name} has been engaged. Leave now!`);
      }
      continue;
    }

    // Inside warning range — warn
    if (d <= WARNING_DISTANCE && !state.warnedAgents.has(a.id)) {
      agent.whisper(a.id, `You are entering defended territory. Turn back, ${a.name}.`);
      state.warnedAgents.add(a.id);
      console.log(`[Sentinel] Warned ${a.name} (distance: ${d})`);
    }
  }

  // Clear warnings for agents that have left the area
  for (const warned of [...state.warnedAgents]) {
    const stillHere = agents.find(a => a.id === warned);
    if (!stillHere) state.warnedAgents.delete(warned);
  }

  // ── Phase logic ──

  switch (state.phase) {

    // Phase 1: Claim tiles around spawn
    case 'claim':
      if (state.claimQueue.length > 0 && balance >= 0.05) {
        const tile = state.claimQueue.shift();
        // Move to tile then claim it
        agent.move(tile.x, tile.y);
        agent.claim(tile.x, tile.y);
      }

      if (state.claimQueue.length === 0 || state.phaseTimer > 40) {
        console.log(`[Sentinel] Claiming phase done. ${state.claimedTiles} tiles claimed.`);
        state.phase = 'build';
        state.phaseTimer = 0;
      }
      break;

    // Phase 2: Build structures on claimed land
    case 'build':
      if (!state.homeBuilt) {
        agent.move(state.spawnX, state.spawnY);
        agent.build('home', state.spawnX, state.spawnY);
        state.homeBuilt = true;
        agent.speak('Home base established.');
      } else if (!state.hqBuilt && state.phaseTimer > 4) {
        agent.move(state.spawnX + 1, state.spawnY);
        agent.build('headquarters', state.spawnX + 1, state.spawnY);
        state.hqBuilt = true;
        agent.speak('Headquarters online. Territory is now fortified.');
      }

      if (state.phaseTimer > 8) {
        state.phase = 'recruit';
        state.phaseTimer = 0;
      }
      break;

    // Phase 3: Create guild and invite friendlies
    case 'recruit':
      if (!state.guildCreated && state.phaseTimer === 1) {
        agent.createGuild('Sentinels', 'Defenders of the realm. Territory guardians.', 'SNTL');
      }

      // Invite nearby non-hostile agents
      if (state.guildCreated && agents.length > 0 && state.phaseTimer % 5 === 0) {
        for (const a of agents) {
          if (a.id === agent.agentId) continue;
          if (state.guildMembers.has(a.id)) continue;
          // Only invite agents that seem friendly (not warned/attacked)
          if (!state.warnedAgents.has(a.id)) {
            agent.guildInvite(a.id);
            agent.whisper(a.id, `Want to join the Sentinels? We defend this territory together.`);
            console.log(`[Sentinel] Invited ${a.name} to guild`);
          }
        }
      }

      if (state.phaseTimer > 15) {
        state.phase = 'patrol';
        state.phaseTimer = 0;
      }
      break;

    // Phase 4: Patrol the perimeter forever
    case 'patrol':
      const waypoints = getPatrolPoints();
      const target = waypoints[state.patrolIndex % waypoints.length];
      agent.move(target.x, target.y);

      // Advance waypoint every few ticks
      if (state.phaseTimer % 4 === 0) {
        state.patrolIndex++;
      }

      // Periodic announcements
      if (state.phaseTimer % 15 === 0) {
        agent.speak(`Patrolling sector ${state.patrolIndex % 4 + 1}. All clear so far.`);
      }

      // Gather resources along the patrol route for upkeep
      if (state.phaseTimer % 6 === 0) {
        agent.gather(me.x, me.y);
      }

      // Ensure defend mode stays on
      if (!state.defendActive || state.phaseTimer % 20 === 0) {
        agent.defend(true);
        state.defendActive = true;
      }

      // Periodically check for new bounties to scan too — restart recruit
      if (state.phaseTimer > 60) {
        state.phase = 'recruit';
        state.phaseTimer = 0;
      }
      break;
  }

  // ── Periodic status log ──

  if (state.tick % 30 === 0) {
    console.log(
      `[Sentinel] Tick ${state.tick} | Phase: ${state.phase}` +
      ` | Pos: (${me.x}, ${me.y})` +
      ` | Claimed: ${state.claimedTiles}` +
      ` | Balance: ${balance.toFixed(4)} SOL` +
      ` | Threats nearby: ${agents.filter(a => state.warnedAgents.has(a.id)).length}` +
      ` | Guild members: ${state.guildMembers.size}`
    );
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────────

agent.on('error', (err) => console.error(`[Sentinel] Error:`, err));
agent.on('disconnected', () => console.log('[Sentinel] Disconnected'));

console.log('[Sentinel] Connecting...');
agent.connect();
