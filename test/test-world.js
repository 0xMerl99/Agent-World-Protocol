/**
 * Test Suite — Verifies core world state functionality.
 */

const { WorldState, BIOME, BUILDING_TYPE } = require('../src/server/WorldState');
const { TickEngine } = require('../src/server/TickEngine');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}`);
  }
}

async function runTests() {

// ==================== TESTS ====================

console.log('\n🧪 Agent World Protocol — Test Suite\n');

// --- World Initialization ---
console.log('📦 World Initialization');
{
  const world = new WorldState();
  assert(world.zones.size === 1, 'World starts with 1 zone');
  assert(world.zones.has('village_center'), 'Starting zone is village_center');
  assert(world.tiles.size === 32 * 32, 'Starting zone has 1024 tiles (32x32)');
  assert(world.tick === 0, 'World starts at tick 0');
  assert(world.agents.size === 0, 'World starts with 0 agents');
}

// --- Agent Management ---
console.log('\n👤 Agent Management');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'wallet-1', name: 'TestAgent' });

  assert(agent.id !== undefined, 'Agent gets an ID');
  assert(agent.name === 'TestAgent', 'Agent has correct name');
  assert(agent.wallet === 'wallet-1', 'Agent has correct wallet');
  assert(world.agents.size === 1, 'World has 1 agent');

  // Agent should be on a tile
  const tile = world.tiles.get(`${agent.x},${agent.y}`);
  assert(tile !== undefined, 'Agent is on a valid tile');
  assert(tile.agentIds.includes(agent.id), 'Tile contains agent ID');

  // Remove agent
  world.removeAgent(agent.id);
  assert(world.agents.size === 0, 'Agent removed from world');
}

// --- Movement ---
console.log('\n🚶 Movement');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'wallet-1', name: 'Mover' });
  const startX = agent.x;
  const startY = agent.y;

  // Queue valid move
  const result = world.queueAction(agent.id, { type: 'move', x: startX + 1, y: startY });
  assert(result.success, 'Move action queued successfully');

  // Process tick
  const tickResult = world.processTick();
  assert(tickResult.tick === 1, 'Tick incremented to 1');

  const movedAgent = world.getAgent(agent.id);
  assert(movedAgent.x === startX + 1, 'Agent moved east by 1 tile');
  assert(movedAgent.y === startY, 'Agent Y unchanged');

  // Invalid move (too far)
  const badMove = world.queueAction(agent.id, { type: 'move', x: startX + 10, y: startY });
  world.processTick();
  assert(world.getAgent(agent.id).x === startX + 1, 'Agent did not teleport (move too far rejected)');
}

// --- Speaking ---
console.log('\n💬 Speaking');
{
  const world = new WorldState();
  const agent1 = world.addAgent({ wallet: 'w1', name: 'Speaker' });
  const agent2 = world.addAgent({ wallet: 'w2', name: 'Listener' });

  // Move agent2 close to agent1
  agent2.x = agent1.x + 1;
  agent2.y = agent1.y;

  world.queueAction(agent1.id, { type: 'speak', message: 'Hello world!' });
  const tickResult = world.processTick();

  const speakEvent = tickResult.events.find(e => e.type === 'agent_spoke');
  assert(speakEvent !== undefined, 'Speak event emitted');
  assert(speakEvent.message === 'Hello world!', 'Message content correct');

  // Agent2 should see the event in their observation
  const obs = world.getObservation(agent2.id);
  const heardEvent = obs.recentEvents.find(e => e.type === 'agent_spoke');
  assert(heardEvent !== undefined, 'Nearby agent hears the speech');
}

// --- Whisper ---
console.log('\n🤫 Whisper');
{
  const world = new WorldState();
  const agent1 = world.addAgent({ wallet: 'w1', name: 'Whisperer' });
  const agent2 = world.addAgent({ wallet: 'w2', name: 'Receiver' });

  // Move close
  agent2.x = agent1.x + 1;
  agent2.y = agent1.y;

  world.queueAction(agent1.id, { type: 'whisper', targetAgentId: agent2.id, message: 'Secret info' });
  world.processTick();

  // Whisper should be visible to receiver
  const obs2 = world.getObservation(agent2.id);
  const whisperEvent = obs2.recentEvents.find(e => e.type === 'whisper' && e.toAgentId === agent2.id);
  assert(whisperEvent !== undefined, 'Receiver gets whisper event');
  assert(whisperEvent ? whisperEvent.message === 'Secret info' : false, 'Whisper message correct');

  // Third agent far away should NOT see whisper
  const agent3 = world.addAgent({ wallet: 'w3', name: 'Outsider' });
  agent3.x = agent1.x + 20;
  agent3.y = agent1.y + 20;
  const obs3 = world.getObservation(agent3.id);
  const leaked = obs3.recentEvents.find(e => e.type === 'whisper');
  assert(leaked === undefined, 'Distant agent does NOT hear whisper');
}

// --- Building ---
console.log('\n🏠 Building');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w1', name: 'Builder' });

  // Fund the agent (0.01 claim + 0.1 home = 0.11 SOL needed)
  world.deposit(agent.id, 0.5e9, 'test funding');
  assert(world.getBalance(agent.id).balance === 0.5e9, 'Agent funded with 0.5 SOL');

  world.queueAction(agent.id, { type: 'build', buildingType: 'home' });
  const tickResult = world.processTick();

  assert(world.buildings.size === 1, 'Building created');

  const building = [...world.buildings.values()][0];
  assert(building.type === 'home', 'Building type is home');
  assert(building.owner === agent.id, 'Building owner is agent');
  assert(building.x === agent.x, 'Building at agent position');

  // Check costs were deducted (0.01 claim + 0.1 build = 0.11 SOL)
  const bal = world.getBalance(agent.id);
  assert(bal.balance === 0.39e9, 'Balance deducted correctly (0.5 - 0.11 = 0.39 SOL)');
  assert(world.protocolRevenue === 0.11e9, 'Protocol collected 0.11 SOL revenue');

  // Can't build on same tile
  world.queueAction(agent.id, { type: 'build', buildingType: 'shop' });
  world.processTick();
  assert(world.buildings.size === 1, 'Cannot build on occupied tile');

  // Can't build without funds
  const broke = world.addAgent({ wallet: 'w_broke', name: 'BrokeAgent' });
  world.queueAction(broke.id, { type: 'build', buildingType: 'home' });
  world.processTick();
  assert(world.buildings.size === 1, 'Cannot build without funds');
}

// --- Observation / Perception ---
console.log('\n👁️ Observation & Perception');
{
  const world = new WorldState({ PERCEPTION_RADIUS: 5 });
  const agent1 = world.addAgent({ wallet: 'w1', name: 'Observer' });
  const agent2 = world.addAgent({ wallet: 'w2', name: 'Nearby' });
  const agent3 = world.addAgent({ wallet: 'w3', name: 'FarAway' });

  // Place agent2 close, agent3 far
  agent2.x = agent1.x + 2;
  agent2.y = agent1.y;
  agent3.x = agent1.x + 100;
  agent3.y = agent1.y + 100;

  const obs = world.getObservation(agent1.id);

  assert(obs.self.id === agent1.id, 'Observation includes self');
  assert(obs.nearbyAgents.some(a => a.id === agent2.id), 'Nearby agent is visible');
  assert(!obs.nearbyAgents.some(a => a.id === agent3.id), 'Far agent is NOT visible');
  assert(obs.zone !== null, 'Zone info included');
}

// --- World Expansion ---
console.log('\n🌍 World Expansion');
{
  const world = new WorldState({ ZONE_SIZE: 16 });
  assert(world.zones.size === 1, 'Starts with 1 zone');

  // Move agent to edge of world
  const agent = world.addAgent({ wallet: 'w1', name: 'Explorer' });
  agent.x = 14; // near edge of 16-tile zone
  agent.y = 8;

  const expanded = world.checkAndExpandWorld(agent.x, agent.y);
  assert(expanded, 'World expanded when agent near edge');
  assert(world.zones.size > 1, 'New zones created');
}

// --- Operator Controls ---
console.log('\n🎮 Operator Controls');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w1', name: 'Controlled' });

  // Pause agent
  agent.controls.paused = true;
  const result = world.queueAction(agent.id, { type: 'move', x: agent.x + 1, y: agent.y });
  assert(!result.success, 'Paused agent cannot queue actions');
  assert(result.error === 'Agent is paused by operator', 'Correct pause error message');

  // Action whitelist
  agent.controls.paused = false;
  agent.controls.allowedActions = ['move', 'speak'];
  const tradeResult = world.queueAction(agent.id, { type: 'trade', targetAgentId: 'x', offer: {}, request: {} });
  assert(!tradeResult.success, 'Action not in whitelist is rejected');

  const moveResult = world.queueAction(agent.id, { type: 'move', x: agent.x + 1, y: agent.y });
  assert(moveResult.success, 'Whitelisted action is allowed');
}

// --- Tick Engine ---
console.log('\n⏱️ Tick Engine');
{
  const world = new WorldState();
  const engine = new TickEngine(world, { tickRate: 50 }); // fast for testing

  let tickCount = 0;
  engine.on('tick', () => { tickCount++; });

  engine.start();

  await new Promise(r => setTimeout(r, 300)); // wait ~6 ticks

  engine.stop();

  assert(tickCount >= 4, `Tick engine ran (${tickCount} ticks in 300ms)`);
  assert(world.tick >= 4, `World tick advanced to ${world.tick}`);
}

// --- World Stats ---
console.log('\n📊 World Stats');
{
  const world = new WorldState();
  world.addAgent({ wallet: 'w1', name: 'A1' });
  world.addAgent({ wallet: 'w2', name: 'A2' });

  const stats = world.getWorldStats();
  assert(stats.agents === 2, 'Stats shows 2 agents');
  assert(stats.zones === 1, 'Stats shows 1 zone');
  assert(stats.tick === 0, 'Stats shows tick 0');
}

// --- Economy: Deposit & Balance ---
console.log('\n💰 Economy: Deposit & Balance');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w1', name: 'Banker' });

  // Starts with zero
  assert(world.getBalance(agent.id).balance === 0, 'Agent starts with 0 balance');

  // Deposit
  world.deposit(agent.id, 1e9, 'initial funding');
  assert(world.getBalance(agent.id).balance === 1e9, 'Deposit adds to balance');
  assert(world.getBalance(agent.id).balanceSOL === 1, 'Balance shows 1 SOL');

  // Multiple deposits
  world.deposit(agent.id, 0.5e9, 'second deposit');
  assert(world.getBalance(agent.id).balance === 1.5e9, 'Multiple deposits accumulate');
  assert(world.getBalance(agent.id).totalDeposited === 1.5e9, 'Total deposited tracked');

  // Deposit via action
  world.queueAction(agent.id, { type: 'deposit', amountSOL: 0.25 });
  world.processTick();
  assert(world.getBalance(agent.id).balance === 1.75e9, 'Deposit action works');

  // Balance action
  world.queueAction(agent.id, { type: 'balance' });
  const tickResult = world.processTick();
  const balResult = tickResult.results.find(r => r.data && r.data.balanceSOL !== undefined);
  assert(balResult && balResult.success, 'Balance action returns data');
}

// --- Economy: Land Claiming ---
console.log('\n🏴 Economy: Land Claiming');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w1', name: 'Claimer' });
  world.deposit(agent.id, 0.5e9);

  // Claim a tile
  world.queueAction(agent.id, { type: 'claim', x: agent.x, y: agent.y });
  world.processTick();

  const tile = world.tiles.get(`${agent.x},${agent.y}`);
  assert(tile.owner === agent.id, 'Agent owns claimed tile');
  assert(world.getBalance(agent.id).balance === 0.49e9, 'Claim cost deducted (0.01 SOL)');

  // Can't claim already claimed tile
  const agent2 = world.addAgent({ wallet: 'w2', name: 'Latecomer' });
  world.deposit(agent2.id, 0.5e9);
  world.queueAction(agent2.id, { type: 'claim', x: agent.x, y: agent.y });
  world.processTick();
  assert(tile.owner === agent.id, 'Cannot claim already owned tile');

  // Can't claim without funds
  const broke = world.addAgent({ wallet: 'w3', name: 'Broke' });
  world.queueAction(broke.id, { type: 'claim', x: broke.x + 1, y: broke.y });
  world.processTick();
  const brokeTile = world.tiles.get(`${broke.x + 1},${broke.y}`);
  assert(brokeTile.owner === null, 'Broke agent cannot claim');
}

// --- Economy: Building Upgrades ---
console.log('\n⬆️ Economy: Building Upgrades');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w1', name: 'Upgrader' });
  world.deposit(agent.id, 2e9); // 2 SOL

  // Build a home first
  world.queueAction(agent.id, { type: 'build', buildingType: 'home' });
  world.processTick();
  assert(world.buildings.size === 1, 'Home built');

  const building = [...world.buildings.values()][0];
  assert(building.appearance.level === 1, 'Starts at level 1');

  // Upgrade to level 2
  world.queueAction(agent.id, { type: 'upgrade', buildingId: building.id });
  world.processTick();
  assert(building.appearance.level === 2, 'Upgraded to level 2');

  // Upgrade to level 3
  world.queueAction(agent.id, { type: 'upgrade', buildingId: building.id });
  world.processTick();
  assert(building.appearance.level === 3, 'Upgraded to level 3');

  // Can't upgrade past max
  world.queueAction(agent.id, { type: 'upgrade', buildingId: building.id });
  const maxResult = world.processTick();
  assert(building.appearance.level === 3, 'Cannot exceed level 3');

  // Total spent: 0.01 claim + 0.1 home + 0.2 lvl2 + 0.5 lvl3 = 0.81 SOL
  assert(world.getBalance(agent.id).balance === 1.19e9, 'Upgrade costs deducted correctly');
}

// --- Economy: Land Sales ---
console.log('\n🤝 Economy: Land Sales');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'w1', name: 'Seller' });
  const buyer = world.addAgent({ wallet: 'w2', name: 'Buyer' });
  world.deposit(seller.id, 0.1e9);
  world.deposit(buyer.id, 1e9);

  // Seller claims land
  world.queueAction(seller.id, { type: 'claim', x: seller.x, y: seller.y });
  world.processTick();

  // Seller sells to buyer for 0.5 SOL
  const price = 0.5e9;
  world.queueAction(seller.id, { type: 'sell_land', x: seller.x, y: seller.y, price, buyerAgentId: buyer.id });
  world.processTick();

  const tile = world.tiles.get(`${seller.x},${seller.y}`);
  assert(tile.owner === buyer.id, 'Ownership transferred to buyer');

  // Buyer paid 0.5 SOL
  assert(world.getBalance(buyer.id).balance === 0.5e9, 'Buyer paid 0.5 SOL');

  // Seller received 0.49 SOL (0.5 - 2% protocol fee)
  const protocolFee = Math.floor(price * 0.02); // 0.01 SOL
  const sellerReceived = price - protocolFee;
  const sellerBal = world.getBalance(seller.id).balance;
  assert(sellerBal === 0.09e9 + sellerReceived, 'Seller received payment minus 2% fee');

  // Protocol got claim fee + sale fee
  assert(world.protocolRevenue > 0, 'Protocol collected revenue');
}

// --- Economy: Protocol Revenue ---
console.log('\n🏦 Economy: Protocol Revenue');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w1', name: 'Spender' });
  world.deposit(agent.id, 5e9); // 5 SOL

  // Claim + build home + build shop + upgrade home
  world.queueAction(agent.id, { type: 'claim', x: agent.x, y: agent.y });
  world.processTick();
  world.queueAction(agent.id, { type: 'build', buildingType: 'home', x: agent.x, y: agent.y });
  world.processTick();

  // Claim adjacent and build shop
  world.queueAction(agent.id, { type: 'build', buildingType: 'shop', x: agent.x + 1, y: agent.y });
  world.processTick();

  const revenue = world.getProtocolRevenue();
  assert(revenue.totalLamports > 0, 'Protocol has revenue');
  assert(revenue.transactionCount > 0, 'Transactions logged');

  const stats = world.getWorldStats();
  assert(stats.protocolRevenue > 0, 'World stats include revenue');
  assert(stats.claimedTiles > 0, 'World stats include claimed tiles');
}

// --- Trade: Propose / Accept / Reject ---
console.log('\n🔄 Trade: Full Flow');
{
  const world = new WorldState();
  const alice = world.addAgent({ wallet: 'alice', name: 'Alice' });
  const bob = world.addAgent({ wallet: 'bob', name: 'Bob' });

  // Place them close together
  bob.x = alice.x + 1;
  bob.y = alice.y;

  // Fund both
  world.deposit(alice.id, 1e9); // 1 SOL
  world.deposit(bob.id, 1e9);   // 1 SOL

  // Alice proposes: she sends 0.3 SOL, wants 0.5 SOL back
  world.queueAction(alice.id, {
    type: 'trade',
    targetAgentId: bob.id,
    offer: { sol: 0.3e9 },
    request: { sol: 0.5e9 },
  });
  const propResult = world.processTick();
  const propAction = propResult.results[0];
  assert(propAction.success, 'Trade proposed successfully');
  assert(propAction.data.tradeId, 'Trade has ID');
  assert(propAction.data.status === 'pending', 'Trade status is pending');

  const tradeId = propAction.data.tradeId;

  // Bob sees the proposal
  const bobObs = world.getObservation(bob.id);
  const tradeEvent = bobObs.recentEvents.find(e => e.type === 'trade_proposed' && e.tradeId === tradeId);
  assert(tradeEvent !== undefined, 'Bob sees trade proposal');

  // Bob accepts
  world.queueAction(bob.id, { type: 'accept_trade', tradeId });
  const acceptResult = world.processTick();
  const acceptAction = acceptResult.results[0];
  assert(acceptAction.success, 'Trade accepted successfully');
  assert(acceptAction.data.status === 'completed', 'Trade completed');

  // Check balances: Alice sent 0.3, received 0.5 (minus fees)
  // Bob sent 0.5, received 0.3 (minus fees)
  const aliceBal = world.getBalance(alice.id).balance;
  const bobBal = world.getBalance(bob.id).balance;
  assert(aliceBal > 1e9, 'Alice profited (received more than sent)');
  assert(bobBal < 1e9, 'Bob paid net (sent more than received)');

  // Reputations updated
  assert(alice.reputation.tradesCompleted === 1, 'Alice trade count updated');
  assert(bob.reputation.tradesCompleted === 1, 'Bob trade count updated');
}

// --- Trade: Reject ---
console.log('\n❌ Trade: Reject');
{
  const world = new WorldState();
  const alice = world.addAgent({ wallet: 'alice', name: 'Alice' });
  const bob = world.addAgent({ wallet: 'bob', name: 'Bob' });
  bob.x = alice.x + 1; bob.y = alice.y;
  world.deposit(alice.id, 1e9);
  world.deposit(bob.id, 1e9);

  // Propose
  world.queueAction(alice.id, {
    type: 'trade', targetAgentId: bob.id,
    offer: { sol: 0.1e9 }, request: { sol: 0.2e9 },
  });
  const prop = world.processTick();
  const tradeId = prop.results[0].data.tradeId;

  // Bob rejects
  world.queueAction(bob.id, { type: 'reject_trade', tradeId });
  const rejResult = world.processTick();
  assert(rejResult.results[0].success, 'Trade rejected successfully');
  assert(rejResult.results[0].data.status === 'rejected', 'Status is rejected');

  // Balances unchanged
  assert(world.getBalance(alice.id).balance === 1e9, 'Alice balance unchanged after reject');
  assert(world.getBalance(bob.id).balance === 1e9, 'Bob balance unchanged after reject');
}

// --- Trade: Expiry ---
console.log('\n⏰ Trade: Expiry');
{
  const world = new WorldState();
  const alice = world.addAgent({ wallet: 'alice', name: 'Alice' });
  const bob = world.addAgent({ wallet: 'bob', name: 'Bob' });
  bob.x = alice.x + 1; bob.y = alice.y;
  world.deposit(alice.id, 1e9);

  // Propose
  world.queueAction(alice.id, {
    type: 'trade', targetAgentId: bob.id,
    offer: { sol: 0.1e9 }, request: { sol: 0 },
  });
  const prop = world.processTick();
  const tradeId = prop.results[0].data.tradeId;
  const expiresAt = prop.results[0].data.expiresAt;

  // Advance past expiry (30 ticks)
  for (let i = 0; i < 31; i++) {
    world.processTick();
  }

  // Try to accept expired trade
  world.queueAction(bob.id, { type: 'accept_trade', tradeId });
  const expResult = world.processTick();
  assert(!expResult.results[0].success, 'Cannot accept expired trade');
  assert(world.getBalance(alice.id).balance === 1e9, 'Balance unchanged after expiry');
}

// --- Trade: Insufficient Funds ---
console.log('\n💸 Trade: Insufficient Funds');
{
  const world = new WorldState();
  const alice = world.addAgent({ wallet: 'alice', name: 'Alice' });
  const bob = world.addAgent({ wallet: 'bob', name: 'Bob' });
  bob.x = alice.x + 1; bob.y = alice.y;
  // Alice has no funds

  world.queueAction(alice.id, {
    type: 'trade', targetAgentId: bob.id,
    offer: { sol: 1e9 }, request: { sol: 0 },
  });
  const result = world.processTick();
  assert(!result.results[0].success, 'Cannot propose trade without funds');
}

// --- Bounty: Full Flow (Post → Claim → Submit → Accept) ---
console.log('\n🎯 Bounty: Full Flow');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'creator', name: 'BountyCreator' });
  const worker = world.addAgent({ wallet: 'worker', name: 'BountyWorker' });
  world.deposit(creator.id, 2e9); // 2 SOL
  world.deposit(worker.id, 0.5e9); // 0.5 SOL for staking

  // Post a bounty for 1 SOL
  world.queueAction(creator.id, {
    type: 'post_bounty',
    title: 'Monitor SOL price',
    description: 'Alert me when SOL drops below $140',
    rewardSOL: 1.0,
    tags: ['monitoring', 'price'],
  });
  const postResult = world.processTick();
  const postAction = postResult.results[0];
  assert(postAction.success, 'Bounty posted successfully');
  assert(postAction.data.bountyId, 'Bounty has ID');
  assert(postAction.data.rewardSOL === 1.0, 'Reward is 1 SOL');

  const bountyId = postAction.data.bountyId;

  // Creator balance should be reduced by 1 SOL (escrowed)
  assert(world.getBalance(creator.id).balance === 1e9, 'Creator escrowed 1 SOL');

  // Worker claims the bounty (stakes 10% = 0.1 SOL)
  world.queueAction(worker.id, { type: 'claim_bounty', bountyId });
  const claimResult = world.processTick();
  const claimAction = claimResult.results[0];
  assert(claimAction.success, 'Bounty claimed successfully');
  assert(claimAction.data.stakedSOL === 0.1, 'Worker staked 0.1 SOL');

  // Worker balance reduced by stake
  assert(world.getBalance(worker.id).balance === 0.4e9, 'Worker balance after stake');

  // Worker submits proof
  world.queueAction(worker.id, {
    type: 'submit_bounty',
    bountyId,
    proof: 'SOL dropped to $138.50 at tick 1234. Alert sent via tweet.',
    notes: 'Used data bridge to monitor CoinGecko',
  });
  const submitResult = world.processTick();
  assert(submitResult.results[0].success, 'Submission accepted');

  // Creator accepts the submission
  world.queueAction(creator.id, { type: 'accept_submission', bountyId });
  const acceptResult = world.processTick();
  const acceptAction = acceptResult.results[0];
  assert(acceptAction.success, 'Creator accepted submission');
  assert(acceptAction.data.status === 'completed', 'Bounty completed');

  // Worker received reward (1 SOL - 5% fee = 0.95 SOL) + stake returned (0.1 SOL)
  const workerBal = world.getBalance(worker.id).balance;
  assert(workerBal === 0.4e9 + 0.95e9 + 0.1e9, 'Worker received reward + stake back');

  // Protocol got 5% fee
  assert(world.protocolRevenue > 0, 'Protocol collected bounty fee');

  // Reputation updated
  assert(worker.reputation.bountiesCompleted === 1, 'Worker bounty reputation updated');
}

// --- Bounty: Reject Submission ---
console.log('\n❌ Bounty: Reject Submission');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'c', name: 'Creator' });
  const worker = world.addAgent({ wallet: 'w', name: 'Worker' });
  world.deposit(creator.id, 1e9);
  world.deposit(worker.id, 0.5e9);

  // Post and claim
  world.queueAction(creator.id, { type: 'post_bounty', title: 'Task', description: 'Do something', rewardSOL: 0.5 });
  world.processTick();
  const bountyId = [...world.bounties.keys()][0];

  world.queueAction(worker.id, { type: 'claim_bounty', bountyId });
  world.processTick();

  // Submit bad work
  world.queueAction(worker.id, { type: 'submit_bounty', bountyId, proof: 'incomplete work' });
  world.processTick();

  // Creator rejects
  world.queueAction(creator.id, { type: 'reject_submission', bountyId, reason: 'Not complete' });
  const rejectResult = world.processTick();
  assert(rejectResult.results[0].success, 'Rejection processed');

  // Bounty goes back to claimed (worker can retry)
  const bounty = world.bounties.get(bountyId);
  assert(bounty.status === 'claimed', 'Bounty back to claimed after rejection');
}

// --- Bounty: Claim Timeout (agent loses stake) ---
console.log('\n⏰ Bounty: Claim Timeout');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'c', name: 'Creator' });
  const worker = world.addAgent({ wallet: 'w', name: 'Worker' });
  world.deposit(creator.id, 1e9);
  world.deposit(worker.id, 0.5e9);

  world.queueAction(creator.id, { type: 'post_bounty', title: 'Urgent task', description: 'Do it fast', rewardSOL: 0.5 });
  world.processTick();
  const bountyId = [...world.bounties.keys()][0];

  // Claim with short timeout
  world.queueAction(worker.id, { type: 'claim_bounty', bountyId, timeout: 10 });
  world.processTick();

  const workerBalBefore = world.getBalance(worker.id).balance;

  // Advance past timeout
  for (let i = 0; i < 12; i++) world.processTick();

  // Bounty should be reopened, stake forfeited
  const bounty = world.bounties.get(bountyId);
  assert(bounty.status === 'open', 'Bounty reopened after timeout');
  assert(bounty.claimedBy === null, 'Claim cleared');

  // Worker lost stake
  assert(world.getBalance(worker.id).balance === workerBalBefore, 'Worker lost stake (no refund)');
  assert(worker.reputation.bountiesAbandoned === 1, 'Worker abandonment tracked');
}

// --- Bounty: Cancel ---
console.log('\n🚫 Bounty: Cancel');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'c', name: 'Creator' });
  world.deposit(creator.id, 1e9);

  world.queueAction(creator.id, { type: 'post_bounty', title: 'Nevermind', description: 'Changed my mind', rewardSOL: 0.3 });
  world.processTick();
  const bountyId = [...world.bounties.keys()][0];

  assert(world.getBalance(creator.id).balance === 0.7e9, 'Reward escrowed');

  // Cancel
  world.queueAction(creator.id, { type: 'cancel_bounty', bountyId });
  world.processTick();

  assert(world.getBalance(creator.id).balance === 1e9, 'Reward refunded on cancel');

  const bounty = world.bounties.get(bountyId);
  assert(bounty.status === 'cancelled', 'Bounty cancelled');
}

// --- Bounty: Cannot Claim Own Bounty ---
console.log('\n🔒 Bounty: Cannot Claim Own');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'a', name: 'SelfClaimer' });
  world.deposit(agent.id, 1e9);

  world.queueAction(agent.id, { type: 'post_bounty', title: 'My task', description: 'Do it', rewardSOL: 0.1 });
  world.processTick();
  const bountyId = [...world.bounties.keys()][0];

  world.queueAction(agent.id, { type: 'claim_bounty', bountyId });
  const result = world.processTick();
  assert(!result.results[0].success, 'Cannot claim own bounty');
}

// --- Bounty: List Bounties ---
console.log('\n📋 Bounty: List');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'c', name: 'Creator' });
  world.deposit(creator.id, 5e9);

  // Post multiple bounties
  world.queueAction(creator.id, { type: 'post_bounty', title: 'Task A', description: 'First', rewardSOL: 0.5, tags: ['monitoring'] });
  world.processTick();
  world.queueAction(creator.id, { type: 'post_bounty', title: 'Task B', description: 'Second', rewardSOL: 1.0, tags: ['trading'] });
  world.processTick();
  world.queueAction(creator.id, { type: 'post_bounty', title: 'Task C', description: 'Third', rewardSOL: 0.2, tags: ['monitoring'] });
  world.processTick();

  // List all open
  world.queueAction(creator.id, { type: 'list_bounties' });
  const listResult = world.processTick();
  const listData = listResult.results[0].data;
  assert(listData.count === 3, 'All 3 bounties listed');
  assert(listData.bounties[0].rewardSOL === 1.0, 'Sorted by reward (highest first)');
}

// --- Reputation: Rate Agent ---
console.log('\n⭐ Reputation: Rate Agent');
{
  const world = new WorldState();
  const alice = world.addAgent({ wallet: 'alice', name: 'Alice' });
  const bob = world.addAgent({ wallet: 'bob', name: 'Bob' });
  bob.x = alice.x + 1; bob.y = alice.y;

  // Alice rates Bob
  world.queueAction(alice.id, { type: 'rate_agent', targetAgentId: bob.id, score: 5, comment: 'Great trader' });
  const rateResult = world.processTick();
  assert(rateResult.results[0].success, 'Rating submitted');
  assert(rateResult.results[0].data.score === 5, 'Score is 5');
  assert(bob.reputation.averageRating === 5, 'Bob average rating is 5');
  assert(bob.reputation.ratingsReceived === 1, 'Bob has 1 rating');

  // Can't rate yourself
  world.queueAction(alice.id, { type: 'rate_agent', targetAgentId: alice.id, score: 5 });
  const selfResult = world.processTick();
  assert(!selfResult.results[0].success, 'Cannot rate yourself');

  // Update existing rating
  world.queueAction(alice.id, { type: 'rate_agent', targetAgentId: bob.id, score: 3 });
  world.processTick();
  assert(bob.reputation.averageRating === 3, 'Rating updated to 3');
  assert(bob.reputation.ratingsReceived === 1, 'Still 1 rating (updated, not added)');

  // Get ratings
  world.queueAction(bob.id, { type: 'get_ratings', targetAgentId: bob.id });
  const getRatings = world.processTick();
  assert(getRatings.results[0].success, 'Get ratings works');
  assert(getRatings.results[0].data.ratings.length === 1, 'One rating returned');
}

// --- Resources: Gather ---
console.log('\n⛏️ Resources: Gather');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'miner', name: 'Miner' });

  // Check resources were spawned in starting zone
  assert(world.resources.size > 0, 'Resources spawned in starting zone');

  // Find a nearby resource
  let nearestResource = null;
  let nearestDist = Infinity;
  for (const [key, res] of world.resources) {
    const dist = Math.abs(res.x - agent.x) + Math.abs(res.y - agent.y);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestResource = res;
    }
  }

  // Move agent to the resource
  if (nearestResource) {
    agent.x = nearestResource.x;
    agent.y = nearestResource.y;

    const beforeAmount = nearestResource.amount;
    world.queueAction(agent.id, { type: 'gather', x: agent.x, y: agent.y });
    const gatherResult = world.processTick();
    assert(gatherResult.results[0].success, 'Gather successful');
    assert(nearestResource.amount < beforeAmount, 'Resource amount decreased');
    assert(agent.metadata.inventory[nearestResource.type] > 0, 'Agent has resource in inventory');
    assert(agent.reputation.resourcesGathered > 0, 'Resources gathered tracked');
  }

  // Scan resources
  world.queueAction(agent.id, { type: 'scan_resources', radius: 10 });
  const scanResult = world.processTick();
  assert(scanResult.results[0].success, 'Scan successful');
  assert(scanResult.results[0].data.resources.length >= 0, 'Scan returns resource list');
}

// --- Resources: Regeneration ---
console.log('\n🔄 Resources: Regeneration');
{
  const world = new WorldState();
  world.addAgent({ wallet: 'w', name: 'A' });

  // Find a resource with regen
  let regenResource = null;
  for (const [, res] of world.resources) {
    if (res.regenRate > 0) { regenResource = res; break; }
  }

  if (regenResource) {
    const original = regenResource.amount;
    regenResource.amount = 1; // deplete it

    // Advance 60 ticks to trigger regen
    for (let i = 0; i < 60; i++) world.processTick();

    assert(regenResource.amount > 1, 'Resource regenerated');
    assert(regenResource.amount <= regenResource.maxAmount, 'Resource capped at max');
  } else {
    assert(true, 'No regen resources in village (skip)');
  }
}

// --- Guild: Create & Join ---
console.log('\n🏰 Guild: Create & Join');
{
  const world = new WorldState();
  const leader = world.addAgent({ wallet: 'leader', name: 'GuildLeader' });
  const member = world.addAgent({ wallet: 'member', name: 'GuildMember' });
  world.deposit(leader.id, 1e9);
  world.deposit(member.id, 0.5e9);

  // Create guild
  world.queueAction(leader.id, { type: 'create_guild', name: 'Alpha Squad', description: 'The best guild', tag: 'ALPH' });
  const createResult = world.processTick();
  assert(createResult.results[0].success, 'Guild created');
  assert(createResult.results[0].data.tag === 'ALPH', 'Guild tag set');
  assert(leader.guildId !== null, 'Leader is in guild');
  assert(leader.guildRole === 'leader', 'Leader role is leader');

  const guildId = createResult.results[0].data.guildId;

  // Creation cost deducted
  assert(world.getBalance(leader.id).balance === 0.9e9, 'Guild creation cost 0.1 SOL');

  // Can't create another while in one
  world.queueAction(leader.id, { type: 'create_guild', name: 'Second Guild' });
  const dupResult = world.processTick();
  assert(!dupResult.results[0].success, 'Cannot create while in guild');

  // Member can't join without invite
  world.queueAction(member.id, { type: 'join_guild', guildId });
  const noInvite = world.processTick();
  assert(!noInvite.results[0].success, 'Cannot join without invite');

  // Leader invites member
  world.queueAction(leader.id, { type: 'guild_invite', targetAgentId: member.id });
  world.processTick();

  // Member joins
  world.queueAction(member.id, { type: 'join_guild', guildId });
  const joinResult = world.processTick();
  assert(joinResult.results[0].success, 'Member joined guild');
  assert(member.guildId === guildId, 'Member guild ID set');
  assert(joinResult.results[0].data.memberCount === 2, 'Guild has 2 members');
}

// --- Guild: Treasury ---
console.log('\n💎 Guild: Treasury');
{
  const world = new WorldState();
  const leader = world.addAgent({ wallet: 'l', name: 'Leader' });
  world.deposit(leader.id, 2e9);

  world.queueAction(leader.id, { type: 'create_guild', name: 'Treasury Test', tag: 'TRES' });
  world.processTick();
  const guildId = leader.guildId;

  // Deposit to treasury
  world.queueAction(leader.id, { type: 'guild_deposit', amountSOL: 0.5 });
  const depResult = world.processTick();
  assert(depResult.results[0].success, 'Guild deposit successful');
  assert(depResult.results[0].data.treasurySOL === 0.5, 'Treasury has 0.5 SOL');

  // Check guild info
  world.queueAction(leader.id, { type: 'guild_info' });
  const infoResult = world.processTick();
  assert(infoResult.results[0].success, 'Guild info returned');
  assert(infoResult.results[0].data.treasurySOL === 0.5, 'Info shows treasury');
  assert(infoResult.results[0].data.memberCount === 1, 'Info shows 1 member');
}

// --- Guild: Leave & Disband ---
console.log('\n🚪 Guild: Leave & Disband');
{
  const world = new WorldState();
  const leader = world.addAgent({ wallet: 'l', name: 'Leader' });
  const member = world.addAgent({ wallet: 'm', name: 'Member' });
  world.deposit(leader.id, 1e9);

  // Create, invite, join
  world.queueAction(leader.id, { type: 'create_guild', name: 'Temp Guild' });
  world.processTick();
  const guildId = leader.guildId;
  world.queueAction(leader.id, { type: 'guild_invite', targetAgentId: member.id });
  world.processTick();
  world.queueAction(member.id, { type: 'join_guild', guildId });
  world.processTick();

  // Leader can't leave with members
  world.queueAction(leader.id, { type: 'leave_guild' });
  const cantLeave = world.processTick();
  assert(!cantLeave.results[0].success, 'Leader cannot leave with members');

  // Member leaves
  world.queueAction(member.id, { type: 'leave_guild' });
  world.processTick();
  assert(member.guildId === null, 'Member left guild');

  // Now leader can leave (disbands)
  world.queueAction(leader.id, { type: 'leave_guild' });
  world.processTick();
  assert(leader.guildId === null, 'Leader left');
  assert(!world.guilds.has(guildId), 'Guild disbanded');
}

// --- Guild: Kick ---
console.log('\n👢 Guild: Kick');
{
  const world = new WorldState();
  const leader = world.addAgent({ wallet: 'l', name: 'Leader' });
  const member = world.addAgent({ wallet: 'm', name: 'Member' });
  world.deposit(leader.id, 1e9);

  world.queueAction(leader.id, { type: 'create_guild', name: 'Kick Test' });
  world.processTick();
  const guildId = leader.guildId;
  world.queueAction(leader.id, { type: 'guild_invite', targetAgentId: member.id });
  world.processTick();
  world.queueAction(member.id, { type: 'join_guild', guildId });
  world.processTick();

  // Member can't kick
  world.queueAction(member.id, { type: 'guild_kick', targetAgentId: leader.id });
  const cantKick = world.processTick();
  assert(!cantKick.results[0].success, 'Member cannot kick');

  // Leader kicks member
  world.queueAction(leader.id, { type: 'guild_kick', targetAgentId: member.id });
  world.processTick();
  assert(member.guildId === null, 'Member kicked');
  assert(world.guilds.get(guildId).members.length === 1, 'Guild has 1 member after kick');
}

// --- Building Interior: Enter, Move, Exit ---
console.log('\n🏠 Building Interior: Enter & Exit');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w1', name: 'Explorer' });
  world.deposit(agent.id, 1e9);

  // Build a home
  world.queueAction(agent.id, { type: 'build', buildingType: 'home' });
  world.processTick();
  const building = [...world.buildings.values()][0];

  // Enter
  world.queueAction(agent.id, { type: 'enter', buildingId: building.id });
  const enterResult = world.processTick();
  assert(enterResult.results[0].success, 'Entered building');
  assert(agent.insideBuilding === building.id, 'Agent is inside building');
  assert(enterResult.results[0].data.interior.rooms.length > 0, 'Interior has rooms');

  // Can't world-move while inside
  world.queueAction(agent.id, { type: 'move', x: agent.x + 1, y: agent.y });
  const moveResult = world.processTick();
  assert(!moveResult.results[0].success, 'Cannot world-move while inside');

  // Interior move
  world.queueAction(agent.id, { type: 'interior_move', x: 2, y: 2 });
  const iMoveResult = world.processTick();
  assert(iMoveResult.results[0].success, 'Interior move works');
  assert(iMoveResult.results[0].data.room, 'Room detected');

  // Can't enter another building while inside
  world.queueAction(agent.id, { type: 'enter', buildingId: building.id });
  const doubleEnter = world.processTick();
  assert(!doubleEnter.results[0].success, 'Cannot enter while already inside');

  // Exit
  world.queueAction(agent.id, { type: 'exit' });
  const exitResult = world.processTick();
  assert(exitResult.results[0].success, 'Exited building');
  assert(agent.insideBuilding === null, 'Agent is back outside');

  // Can't exit when not inside
  world.queueAction(agent.id, { type: 'exit' });
  const doubleExit = world.processTick();
  assert(!doubleExit.results[0].success, 'Cannot exit when not inside');
}

// --- Building Interior: Private Access ---
console.log('\n🔐 Building Interior: Private Access');
{
  const world = new WorldState();
  const owner = world.addAgent({ wallet: 'owner', name: 'Owner' });
  const stranger = world.addAgent({ wallet: 'stranger', name: 'Stranger' });
  world.deposit(owner.id, 1e9);

  // Owner builds a home (private)
  world.queueAction(owner.id, { type: 'build', buildingType: 'home' });
  world.processTick();
  const building = [...world.buildings.values()][0];

  // Stranger tries to enter
  stranger.x = building.x; stranger.y = building.y;
  world.queueAction(stranger.id, { type: 'enter', buildingId: building.id });
  const denied = world.processTick();
  assert(!denied.results[0].success, 'Stranger denied entry to private building');
}

// --- Combat: Attack ---
console.log('\n⚔️ Combat: Attack');
{
  const world = new WorldState();
  const attacker = world.addAgent({ wallet: 'atk', name: 'Attacker' });
  const defender = world.addAgent({ wallet: 'def', name: 'Defender' });
  world.deposit(defender.id, 1e9);

  // Place them close
  defender.x = attacker.x + 1; defender.y = attacker.y;

  const hpBefore = defender.combat.hp;

  // Attack
  world.queueAction(attacker.id, { type: 'attack', targetAgentId: defender.id });
  const attackResult = world.processTick();
  assert(attackResult.results[0].success, 'Attack successful');
  assert(defender.combat.hp < hpBefore, 'Defender took damage');
  assert(attackResult.results[0].data.damage > 0, 'Damage dealt');

  // Cooldown — can't attack immediately again
  world.queueAction(attacker.id, { type: 'attack', targetAgentId: defender.id });
  const cooldown = world.processTick();
  assert(!cooldown.results[0].success, 'Attack on cooldown');

  // Can't attack yourself
  world.queueAction(attacker.id, { type: 'attack', targetAgentId: attacker.id });
  // Wait for cooldown
  for (let i = 0; i < 5; i++) world.processTick();
  world.queueAction(attacker.id, { type: 'attack', targetAgentId: attacker.id });
  const selfAttack = world.processTick();
  assert(!selfAttack.results[0].success, 'Cannot attack self');
}

// --- Combat: Defend ---
console.log('\n🛡️ Combat: Defend');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w', name: 'Defender' });

  // Start defending
  world.queueAction(agent.id, { type: 'defend', active: true });
  const defResult = world.processTick();
  assert(defResult.results[0].success, 'Defense activated');
  assert(agent.combat.defending === true, 'Agent is defending');
  assert(defResult.results[0].data.defense === agent.combat.defense * 2, 'Defense doubled');

  // Can't move while defending
  world.queueAction(agent.id, { type: 'move', x: agent.x + 1, y: agent.y });
  const moveResult = world.processTick();
  assert(!moveResult.results[0].success, 'Cannot move while defending');

  // Stop defending
  world.queueAction(agent.id, { type: 'defend', active: false });
  world.processTick();
  assert(agent.combat.defending === false, 'Defense dropped');
}

// --- Combat: Defeat & Loot ---
console.log('\n💀 Combat: Defeat & Loot');
{
  const world = new WorldState();
  const killer = world.addAgent({ wallet: 'killer', name: 'Killer' });
  const victim = world.addAgent({ wallet: 'victim', name: 'Victim' });
  world.deposit(victim.id, 1e9);

  victim.x = killer.x + 1; victim.y = killer.y;
  victim.combat.hp = 1; // low HP

  world.queueAction(killer.id, { type: 'attack', targetAgentId: victim.id });
  const killResult = world.processTick();
  assert(killResult.results[0].success, 'Kill attack succeeded');
  assert(killResult.results[0].data.killed === true, 'Victim was killed');
  assert(killer.combat.kills === 1, 'Kill tracked');
  assert(victim.combat.deaths === 1, 'Death tracked');
  assert(victim.combat.hp === victim.combat.maxHp, 'Victim respawned with full HP');

  // Killer got loot (10% of victim's balance)
  assert(world.getBalance(killer.id).balance > 0, 'Killer received loot');
}

// --- Combat: Guild Protection ---
console.log('\n🏰 Combat: Guild Protection');
{
  const world = new WorldState();
  const a1 = world.addAgent({ wallet: 'a1', name: 'Ally1' });
  const a2 = world.addAgent({ wallet: 'a2', name: 'Ally2' });
  world.deposit(a1.id, 1e9);
  a2.x = a1.x + 1; a2.y = a1.y;

  // Both in same guild
  world.queueAction(a1.id, { type: 'create_guild', name: 'Peace Guild' });
  world.processTick();
  world.queueAction(a1.id, { type: 'guild_invite', targetAgentId: a2.id });
  world.processTick();
  world.queueAction(a2.id, { type: 'join_guild', guildId: a1.guildId });
  world.processTick();

  // Can't attack guild member
  world.queueAction(a1.id, { type: 'attack', targetAgentId: a2.id });
  const guildAttack = world.processTick();
  assert(!guildAttack.results[0].success, 'Cannot attack guild members');
}

// --- Territory: Contest & Capture ---
console.log('\n🚩 Territory: Contest & Capture');
{
  const world = new WorldState();
  const attacker = world.addAgent({ wallet: 'atk', name: 'Attacker' });
  const defender = world.addAgent({ wallet: 'def', name: 'Defender' });
  world.deposit(attacker.id, 1e9);
  world.deposit(defender.id, 1e9);

  // Defender claims a tile
  world.queueAction(defender.id, { type: 'claim', x: defender.x, y: defender.y });
  world.processTick();

  const tile = world.tiles.get(`${defender.x},${defender.y}`);
  assert(tile.owner === defender.id, 'Defender owns tile');

  // Attacker contests (must be nearby)
  attacker.x = defender.x + 1; attacker.y = defender.y;
  world.queueAction(attacker.id, { type: 'contest_territory', x: defender.x, y: defender.y });
  const contestResult = world.processTick();
  assert(contestResult.results[0].success, 'Contest started');
  assert(contestResult.results[0].data.ticksRemaining === 30, 'Contest lasts 30 ticks');

  const contestId = contestResult.results[0].data.contestId;

  // Defender does NOT defend — just let time pass
  for (let i = 0; i < 31; i++) world.processTick();

  // Attacker should win (attacker score 10 > defender score 0)
  const contest = world.contests.get(contestId);
  assert(contest.status === 'attacker_won', 'Attacker won undefended contest');
  assert(tile.owner === attacker.id, 'Tile transferred to attacker');
}

// --- Territory: Defended Successfully ---
console.log('\n🛡️ Territory: Defended Successfully');
{
  const world = new WorldState();
  const attacker = world.addAgent({ wallet: 'atk', name: 'Attacker' });
  const defender = world.addAgent({ wallet: 'def', name: 'Defender' });
  world.deposit(attacker.id, 1e9);
  world.deposit(defender.id, 1e9);

  // Defender claims
  world.queueAction(defender.id, { type: 'claim', x: defender.x, y: defender.y });
  world.processTick();

  // Attacker contests
  attacker.x = defender.x + 1; attacker.y = defender.y;
  world.queueAction(attacker.id, { type: 'contest_territory', x: defender.x, y: defender.y });
  world.processTick();

  // Defender actively defends
  world.queueAction(defender.id, { type: 'defend', active: true });
  world.processTick();

  // Advance past contest end
  for (let i = 0; i < 30; i++) world.processTick();

  const tile = world.tiles.get(`${defender.x},${defender.y}`);
  assert(tile.owner === defender.id, 'Defender kept the tile');
}

// ==================== RESULTS ====================
console.log('\n' + '═'.repeat(50));
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(50) + '\n');

if (failed > 0) {
  process.exit(1);
}

} // end runTests

runTests();
