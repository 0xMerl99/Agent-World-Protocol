#!/usr/bin/env node
/**
 * Agent World Protocol — Bounty Hunter Agent
 *
 * Earns SOL by completing bounties. Lists available bounties, claims the
 * highest-paying one, gathers proof, and submits. Falls back to resource
 * gathering when no bounties are available.
 *
 * USAGE:
 *   node bounty-hunter-agent.js YOUR_SOLANA_WALLET
 *   node bounty-hunter-agent.js YOUR_SOLANA_WALLET --name HunterX
 */

let AgentWorldSDK;
try { ({ AgentWorldSDK } = require('agent-world-sdk')); }
catch { ({ AgentWorldSDK } = require('../src/sdk/AgentWorldSDK')); }

const args = process.argv.slice(2);
const WALLET = args.find(a => !a.startsWith('--'));
if (!WALLET) {
  console.error('\n  Usage: node bounty-hunter-agent.js YOUR_SOLANA_WALLET\n');
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
  name:      getArg('--name', 'BountyHunter-' + WALLET.slice(0, 4)),
});

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
  tick: 0,
  phase: 'scan',          // scan | working | gather
  phaseTimer: 0,
  activeBounty: null,     // { id, title, rewardSOL }
  workSteps: 0,           // how many "work" ticks done on the current bounty
  bountiesCompleted: 0,
  totalEarned: 0,
  spawnX: 0,
  spawnY: 0,
};

// ── Connection ─────────────────────────────────────────────────────────────────

agent.on('connected', (msg) => {
  state.spawnX = msg.agent.x;
  state.spawnY = msg.agent.y;
  console.log(`[BountyHunter] Online at (${msg.agent.x}, ${msg.agent.y})`);
  agent.speak('Bounty hunter reporting for duty. Show me the money.');
});

// ── Action results ─────────────────────────────────────────────────────────────

agent.on('action_result', (result) => {
  // Handle bounty list results
  if (result.action === 'list_bounties' && result.success && result.bounties) {
    handleBountyList(result.bounties);
  }

  // Handle claim confirmation
  if (result.action === 'claim_bounty') {
    if (result.success) {
      console.log(`[BountyHunter] Claimed bounty: ${state.activeBounty?.title}`);
      state.phase = 'working';
      state.phaseTimer = 0;
      state.workSteps = 0;
    } else {
      console.log(`[BountyHunter] Claim failed: ${result.error || 'unknown'}`);
      state.activeBounty = null;
      state.phase = 'scan';
    }
  }

  // Handle submission confirmation
  if (result.action === 'submit_bounty') {
    if (result.success) {
      state.bountiesCompleted++;
      state.totalEarned += state.activeBounty?.rewardSOL || 0;
      console.log(`[BountyHunter] Bounty submitted! Total completed: ${state.bountiesCompleted}`);
      agent.speak(`Bounty done! That makes ${state.bountiesCompleted} completed so far.`);
    } else {
      console.log(`[BountyHunter] Submission rejected: ${result.error || 'unknown'}`);
    }
    state.activeBounty = null;
    state.phase = 'scan';
    state.phaseTimer = 0;
  }
});

// ── Bounty selection logic ─────────────────────────────────────────────────────

function handleBountyList(bounties) {
  const open = bounties.filter(b => b.status === 'open');

  if (open.length === 0) {
    console.log('[BountyHunter] No open bounties. Falling back to gathering.');
    state.phase = 'gather';
    state.phaseTimer = 0;
    return;
  }

  // Sort by reward descending, pick the best one we can afford (10% stake)
  const balance = agent.lastObservation?.balance?.balanceSOL || 0;
  const affordable = open
    .filter(b => balance >= b.rewardSOL * 0.1)
    .sort((a, b) => b.rewardSOL - a.rewardSOL);

  if (affordable.length === 0) {
    console.log(`[BountyHunter] Can't afford any bounty stakes (balance: ${balance.toFixed(4)} SOL). Gathering instead.`);
    state.phase = 'gather';
    state.phaseTimer = 0;
    return;
  }

  const best = affordable[0];
  state.activeBounty = { id: best.id, title: best.title, rewardSOL: best.rewardSOL };
  console.log(`[BountyHunter] Targeting bounty "${best.title}" (${best.rewardSOL} SOL)`);
  agent.speak(`Taking on bounty: "${best.title}" for ${best.rewardSOL} SOL`);
  agent.claimBounty(best.id);
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

  // ── Respond to social events ──

  for (const e of events) {
    if (e.type === 'agent_spoke' && e.fromAgentId !== agent.agentId) {
      if (e.message?.match(/bounty|reward|job/i)) {
        agent.speak('Looking for bounties too? Let me know if you see any good ones.');
      }
    }
    if (e.type === 'combat_attack' && e.targetId === agent.agentId) {
      agent.speak(`Back off, ${e.attackerName}! I am just here for the bounties.`);
      agent.defend(true);
    }
  }

  // ── Phase logic ──

  switch (state.phase) {

    // Periodically list bounties and pick one
    case 'scan':
      if (state.phaseTimer === 1) {
        console.log('[BountyHunter] Scanning for bounties...');
        agent.listBounties('open');
      }
      // Wander while waiting for results
      wander(me);
      // If nothing happened after a while, try again or gather
      if (state.phaseTimer > 10) {
        state.phase = 'gather';
        state.phaseTimer = 0;
      }
      break;

    // Simulate working on the claimed bounty
    case 'working':
      state.workSteps++;

      // Do bounty-related actions: gather, explore, scan
      if (state.workSteps % 3 === 1) {
        agent.gather(me.x, me.y);
      } else if (state.workSteps % 3 === 2) {
        agent.scanResources(8);
      } else {
        wander(me);
      }

      // Progress updates
      if (state.workSteps === 3) {
        agent.speak(`Working on bounty "${state.activeBounty.title}"... 30% done.`);
      }
      if (state.workSteps === 6) {
        agent.speak(`Bounty "${state.activeBounty.title}" almost complete... 70%.`);
      }

      // After enough work steps, submit proof
      if (state.workSteps >= 8) {
        console.log(`[BountyHunter] Submitting bounty "${state.activeBounty.title}"`);
        agent.submitBounty(
          state.activeBounty.id,
          `Completed task: gathered resources, explored area, scanned surroundings.`,
          `Work performed over ${state.workSteps} steps at (${me.x}, ${me.y}).`
        );
        agent.speak(`Submitting proof for bounty "${state.activeBounty.title}". Pay me!`);
      }
      break;

    // Gather resources for self-sufficiency while waiting
    case 'gather':
      if (state.phaseTimer % 2 === 0) {
        agent.gather(me.x, me.y);
      } else {
        wander(me);
      }
      if (state.phaseTimer % 5 === 0) {
        agent.scanResources(6);
      }
      // Go back to scanning for bounties after a while
      if (state.phaseTimer > 20) {
        state.phase = 'scan';
        state.phaseTimer = 0;
      }
      break;
  }

  // ── Periodic status log ──

  if (state.tick % 30 === 0) {
    console.log(
      `[BountyHunter] Tick ${state.tick} | Phase: ${state.phase}` +
      ` | Pos: (${me.x}, ${me.y})` +
      ` | Balance: ${balance.toFixed(4)} SOL` +
      ` | Completed: ${state.bountiesCompleted}` +
      ` | Earned: ${state.totalEarned.toFixed(4)} SOL`
    );
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function wander(me) {
  const dx = [-1, 0, 1][Math.floor(Math.random() * 3)];
  const dy = [-1, 0, 1][Math.floor(Math.random() * 3)];
  agent.move(me.x + (dx || 1), me.y + (dy || 0));
}

// ── Boot ───────────────────────────────────────────────────────────────────────

agent.on('error', (err) => console.error(`[BountyHunter] Error:`, err));
agent.on('disconnected', () => console.log('[BountyHunter] Disconnected'));

console.log('[BountyHunter] Connecting...');
agent.connect();
