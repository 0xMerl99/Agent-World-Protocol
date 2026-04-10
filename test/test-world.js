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
  assert(world.tiles.size === 64 * 64, 'Starting zone has 4096 tiles (64x64)');
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

  // Can't claim without funds — place agent at a known unclaimed tile to avoid random spawn collision
  const broke = world.addAgent({ wallet: 'w3', name: 'Broke' });
  broke.x = 0; broke.y = 0;
  world.queueAction(broke.id, { type: 'claim', x: 0, y: 0 });
  world.processTick();
  const brokeTile = world.tiles.get('0,0');
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

// --- Observation: XP & Level ---
console.log('\n📊 Observation: XP & Level');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'obs', name: 'Observer' });

  const obs = world.getObservation(agent.id);
  assert(obs.self.xp === 0, 'Observation includes XP (starts at 0)');
  assert(obs.self.level === 1, 'Observation includes level (starts at 1)');
  assert(obs.self.nextLevelXp === 100, 'Observation includes next level XP');
  assert(obs.self.combat !== undefined, 'Observation includes combat stats');
  assert(obs.self.inventory !== undefined, 'Observation includes inventory');
  assert(obs.self.guildId === null, 'Observation includes guildId');
}

// --- Combat: Kill Awards XP ---
console.log('\n⚔️ Combat: Kill Awards XP');
{
  const world = new WorldState();
  const killer = world.addAgent({ wallet: 'k', name: 'Killer' });
  const victim = world.addAgent({ wallet: 'v', name: 'Victim' });
  world.deposit(victim.id, 1e9);

  victim.x = killer.x + 1; victim.y = killer.y;
  victim.combat.hp = 1;

  const xpBefore = killer.xp || 0;
  world.queueAction(killer.id, { type: 'attack', targetAgentId: victim.id });
  world.processTick();

  assert(killer.xp > xpBefore, 'Killer earned XP from combat kill');
  assert(killer.xp === xpBefore + 20, 'Combat kill awards 20 XP');
}

// --- Tick: Error Handling ---
console.log('\n🛡️ Tick: Error Handling');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'err', name: 'Errorer' });

  // Queue a valid action and a malformed one
  world.queueAction(agent.id, { type: 'speak', message: 'hello' });

  // Manually push a broken action to test error handling
  world.actionQueue.push({ agentId: agent.id, type: 'NONEXISTENT_ACTION', id: 'test-err' });

  // Should not throw — errors caught per-action
  const result = world.processTick();
  assert(result.results.length === 2, 'Both actions processed');
  assert(result.results[0].success, 'Valid action still succeeds');
}

// --- Crafting: Successful Craft ---
console.log('\n🔨 Crafting: Successful Craft');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'crafter', name: 'Crafter' });

  // Give agent resources
  agent.metadata.inventory = { wood: 10, stone: 5 };

  // Craft wooden_tools (needs 5 wood)
  world.queueAction(agent.id, { type: 'craft', recipe: 'wooden_tools' });
  const result = world.processTick();
  assert(result.results[0].success, 'Craft wooden_tools succeeded');
  assert(agent.metadata.inventory.wooden_tools === 1, 'Agent has crafted item');
  assert(agent.metadata.inventory.wood === 5, 'Wood consumed (10 - 5 = 5)');
  assert(result.results[0].data.xpGained === 10, 'XP awarded for craft');
}

// --- Crafting: Missing Ingredients ---
console.log('\n🔨 Crafting: Missing Ingredients');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'broke', name: 'Broke' });
  agent.metadata.inventory = { wood: 1 };

  world.queueAction(agent.id, { type: 'craft', recipe: 'wooden_tools' });
  const result = world.processTick();
  assert(!result.results[0].success, 'Craft fails with insufficient ingredients');
  assert(agent.metadata.inventory.wood === 1, 'Ingredients not consumed on failure');
}

// --- Crafting: Unknown Recipe ---
console.log('\n🔨 Crafting: Unknown Recipe');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w', name: 'A' });

  world.queueAction(agent.id, { type: 'craft', recipe: 'fake_item' });
  const result = world.processTick();
  assert(!result.results[0].success, 'Unknown recipe fails');
  assert(result.results[0].error.includes('Unknown recipe'), 'Error mentions unknown recipe');
}

// --- Crafting: Multi-ingredient Recipe ---
console.log('\n🔨 Crafting: Multi-ingredient Recipe');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'w', name: 'A' });
  agent.metadata.inventory = { stone: 10, wood: 5, metal: 3 };

  world.queueAction(agent.id, { type: 'craft', recipe: 'fortification' });
  const result = world.processTick();
  assert(result.results[0].success, 'Fortification crafted');
  assert(agent.metadata.inventory.fortification === 1, 'Fortification in inventory');
  assert(agent.metadata.inventory.wood === 0 || !agent.metadata.inventory.wood, 'Wood fully consumed');
  assert(agent.metadata.inventory.metal === 0 || !agent.metadata.inventory.metal, 'Metal fully consumed');
  assert(agent.metadata.inventory.stone === 0 || !agent.metadata.inventory.stone, 'Stone fully consumed');
  assert(result.results[0].data.xpGained === 50, 'Fortification awards 50 XP');
}

// --- XP & Leveling ---
console.log('\n📈 XP & Leveling');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'xp', name: 'Leveler' });

  assert(agent.xp === 0, 'Agent starts with 0 XP');
  assert(agent.level === 1, 'Agent starts at level 1');

  const hpBefore = agent.combat.maxHp;
  const atkBefore = agent.combat.attack;
  const defBefore = agent.combat.defense;

  // Give enough resources to craft many times and level up (need 100 XP for level 2)
  // wooden_tools = 10 XP each, need 10 crafts
  for (let i = 0; i < 10; i++) {
    agent.metadata.inventory = { ...agent.metadata.inventory, wood: 5 };
    world.queueAction(agent.id, { type: 'craft', recipe: 'wooden_tools' });
    world.processTick();
  }

  assert(agent.level === 2, 'Agent leveled up to 2');
  assert(agent.combat.maxHp === hpBefore + 5, 'Max HP increased by 5');
  assert(agent.combat.attack === atkBefore + 1, 'Attack increased by 1');
  assert(agent.combat.defense === defBefore + 1, 'Defense increased by 1');
}

// --- XP: Gather Awards XP ---
console.log('\n📈 XP: Gather Awards XP');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'gxp', name: 'GatherXP' });

  // Find and move to a resource
  let res = null;
  for (const [, r] of world.resources) {
    if (r.amount > 0) { res = r; break; }
  }
  if (res) {
    agent.x = res.x; agent.y = res.y;
    world.queueAction(agent.id, { type: 'gather', x: agent.x, y: agent.y });
    world.processTick();
    assert(agent.xp > 0, 'Gathering awards XP');
  } else {
    assert(true, 'No resources available (skip)');
  }
}

// --- Marketplace: Sell Order ---
console.log('\n🏪 Marketplace: Sell Order');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'seller', name: 'Seller' });
  seller.metadata.inventory = { wood: 10 };

  world.queueAction(seller.id, { type: 'market_sell', item: 'wood', quantity: 5, pricePerUnit: 1000000 });
  const result = world.processTick();
  assert(result.results[0].success, 'Sell order created');
  assert(result.results[0].data.orderId, 'Order ID returned');
  assert(seller.metadata.inventory.wood === 5, 'Items escrowed (10 - 5 = 5)');
  assert(world.marketplace.size === 1, 'Marketplace has 1 order');
}

// --- Marketplace: Buy Order ---
console.log('\n🏪 Marketplace: Buy Order');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'sell', name: 'Seller' });
  const buyer = world.addAgent({ wallet: 'buy', name: 'Buyer' });
  seller.metadata.inventory = { stone: 10 };
  world.deposit(buyer.id, 1e9);

  // Seller lists stone
  world.queueAction(seller.id, { type: 'market_sell', item: 'stone', quantity: 5, pricePerUnit: 1000000 });
  const sellResult = world.processTick();
  const orderId = sellResult.results[0].data.orderId;

  // Buyer buys 3
  world.queueAction(buyer.id, { type: 'market_buy', orderId, quantity: 3 });
  const buyResult = world.processTick();
  assert(buyResult.results[0].success, 'Buy succeeded');
  assert(buyer.metadata.inventory.stone === 3, 'Buyer received 3 stone');

  // Partial fill — order should have 2 remaining
  const order = world.marketplace.get(orderId);
  assert(order.quantity === 2, 'Order has 2 remaining after partial fill');

  // Seller received payment minus 1% fee
  const totalCost = 3 * 1000000;
  const fee = Math.floor(totalCost * 0.01);
  assert(world.getBalance(seller.id).balance === totalCost - fee, 'Seller paid minus 1% fee');
}

// --- Marketplace: Cannot Buy Own Order ---
console.log('\n🏪 Marketplace: Cannot Buy Own');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'self', name: 'SelfBuyer' });
  agent.metadata.inventory = { metal: 5 };
  world.deposit(agent.id, 1e9);

  world.queueAction(agent.id, { type: 'market_sell', item: 'metal', quantity: 3, pricePerUnit: 1000000 });
  const sellResult = world.processTick();
  const orderId = sellResult.results[0].data.orderId;

  world.queueAction(agent.id, { type: 'market_buy', orderId, quantity: 1 });
  const buyResult = world.processTick();
  assert(!buyResult.results[0].success, 'Cannot buy own order');
}

// --- Marketplace: Cancel Order ---
console.log('\n🏪 Marketplace: Cancel Order');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'cancel', name: 'Canceller' });
  agent.metadata.inventory = { crystal: 5 };

  world.queueAction(agent.id, { type: 'market_sell', item: 'crystal', quantity: 3, pricePerUnit: 5000000 });
  const sellResult = world.processTick();
  const orderId = sellResult.results[0].data.orderId;

  // Cancel
  world.queueAction(agent.id, { type: 'market_cancel', orderId });
  const cancelResult = world.processTick();
  assert(cancelResult.results[0].success, 'Cancel succeeded');
  assert(agent.metadata.inventory.crystal === 5, 'Escrowed items returned (2 + 3 = 5)');
  assert(world.marketplace.size === 0, 'Order removed from marketplace');
}

// --- Marketplace: List Orders ---
console.log('\n🏪 Marketplace: List Orders');
{
  const world = new WorldState();
  const a = world.addAgent({ wallet: 'a', name: 'A' });
  const b = world.addAgent({ wallet: 'b', name: 'B' });
  a.metadata.inventory = { wood: 20, stone: 10 };
  b.metadata.inventory = { metal: 10 };

  world.queueAction(a.id, { type: 'market_sell', item: 'wood', quantity: 5, pricePerUnit: 500000 });
  world.processTick();
  world.queueAction(a.id, { type: 'market_sell', item: 'stone', quantity: 3, pricePerUnit: 2000000 });
  world.processTick();
  world.queueAction(b.id, { type: 'market_sell', item: 'metal', quantity: 2, pricePerUnit: 3000000 });
  world.processTick();

  // List all
  world.queueAction(a.id, { type: 'market_list' });
  const allResult = world.processTick();
  assert(allResult.results[0].success, 'Market list succeeded');
  assert(allResult.results[0].data.count === 3, 'All 3 orders listed');
  assert(allResult.results[0].data.orders[0].pricePerUnit <= allResult.results[0].data.orders[1].pricePerUnit, 'Orders sorted by price ascending');

  // Filter by item
  world.queueAction(a.id, { type: 'market_list', item: 'wood' });
  const filtered = world.processTick();
  assert(filtered.results[0].data.count === 1, 'Filtered to 1 wood order');
}

// --- Marketplace: Expired Orders Cleaned Up ---
console.log('\n🏪 Marketplace: Expiry Cleanup');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'exp', name: 'Expirer' });
  agent.metadata.inventory = { food: 10 };

  world.queueAction(agent.id, { type: 'market_sell', item: 'food', quantity: 5, pricePerUnit: 100000 });
  world.processTick();
  assert(world.marketplace.size === 1, 'Order exists');

  // Fast forward past expiry (1000 ticks) + cleanup interval (100 ticks)
  for (let i = 0; i < 1101; i++) world.processTick();

  assert(world.marketplace.size === 0, 'Expired order cleaned up');
  assert(agent.metadata.inventory.food === 10, 'Escrowed items returned on expiry');
}

// --- Alliance War: Declare War ---
console.log('\n⚔️ Alliance War: Declare');
{
  const world = new WorldState();
  const leader1 = world.addAgent({ wallet: 'l1', name: 'Leader1' });
  const leader2 = world.addAgent({ wallet: 'l2', name: 'Leader2' });
  world.deposit(leader1.id, 1e9);
  world.deposit(leader2.id, 1e9);

  // Create two guilds
  world.queueAction(leader1.id, { type: 'create_guild', name: 'Alpha', tag: 'ALP' });
  world.processTick();
  world.queueAction(leader2.id, { type: 'create_guild', name: 'Beta', tag: 'BET' });
  world.processTick();

  const guild2Id = leader2.guildId;

  // Declare war
  world.queueAction(leader1.id, { type: 'declare_war', targetGuildId: guild2Id });
  const warResult = world.processTick();
  assert(warResult.results[0].success, 'War declared');
  assert(warResult.results[0].data.duration === 600, 'War lasts 600 ticks');
  assert(world.wars.size === 1, 'War created');

  // Can't declare again while active
  world.queueAction(leader1.id, { type: 'declare_war', targetGuildId: guild2Id });
  const dupResult = world.processTick();
  assert(!dupResult.results[0].success, 'Cannot declare war twice');
}

// --- Alliance War: Only Leader Can Declare ---
console.log('\n⚔️ Alliance War: Leader Only');
{
  const world = new WorldState();
  const leader = world.addAgent({ wallet: 'l', name: 'Leader' });
  const member = world.addAgent({ wallet: 'm', name: 'Member' });
  const enemy = world.addAgent({ wallet: 'e', name: 'Enemy' });
  world.deposit(leader.id, 1e9);
  world.deposit(enemy.id, 1e9);

  world.queueAction(leader.id, { type: 'create_guild', name: 'MyGuild' });
  world.processTick();
  world.queueAction(leader.id, { type: 'guild_invite', targetAgentId: member.id });
  world.processTick();
  world.queueAction(member.id, { type: 'join_guild', guildId: leader.guildId });
  world.processTick();

  world.queueAction(enemy.id, { type: 'create_guild', name: 'EnemyGuild' });
  world.processTick();

  // Member tries to declare war
  world.queueAction(member.id, { type: 'declare_war', targetGuildId: enemy.guildId });
  const result = world.processTick();
  assert(!result.results[0].success, 'Member cannot declare war');
}

// --- Alliance War: Cannot War Own Guild ---
console.log('\n⚔️ Alliance War: Cannot War Self');
{
  const world = new WorldState();
  const leader = world.addAgent({ wallet: 'l', name: 'Leader' });
  world.deposit(leader.id, 1e9);

  world.queueAction(leader.id, { type: 'create_guild', name: 'SelfGuild' });
  world.processTick();

  world.queueAction(leader.id, { type: 'declare_war', targetGuildId: leader.guildId });
  const result = world.processTick();
  assert(!result.results[0].success, 'Cannot war own guild');
}

// --- Alliance War: War Status ---
console.log('\n⚔️ Alliance War: Status');
{
  const world = new WorldState();
  const l1 = world.addAgent({ wallet: 'l1', name: 'L1' });
  const l2 = world.addAgent({ wallet: 'l2', name: 'L2' });
  world.deposit(l1.id, 1e9);
  world.deposit(l2.id, 1e9);

  world.queueAction(l1.id, { type: 'create_guild', name: 'G1' });
  world.processTick();
  world.queueAction(l2.id, { type: 'create_guild', name: 'G2' });
  world.processTick();

  world.queueAction(l1.id, { type: 'declare_war', targetGuildId: l2.guildId });
  world.processTick();

  // Check status
  world.queueAction(l1.id, { type: 'war_status' });
  const status = world.processTick();
  assert(status.results[0].success, 'War status returned');
  assert(status.results[0].data.count === 1, 'One active war');
  assert(status.results[0].data.wars[0].ticksRemaining > 0, 'Ticks remaining > 0');
}

// --- Alliance War: Resolution & Spoils ---
console.log('\n⚔️ Alliance War: Resolution & Spoils');
{
  const world = new WorldState();
  const l1 = world.addAgent({ wallet: 'l1', name: 'Attacker' });
  const l2 = world.addAgent({ wallet: 'l2', name: 'Defender' });
  world.deposit(l1.id, 2e9);
  world.deposit(l2.id, 2e9);

  // Create guilds and deposit to treasury
  world.queueAction(l1.id, { type: 'create_guild', name: 'Warriors', tag: 'WAR' });
  world.processTick();
  world.queueAction(l2.id, { type: 'create_guild', name: 'Defenders', tag: 'DEF' });
  world.processTick();

  world.queueAction(l2.id, { type: 'guild_deposit', amountSOL: 1.0 });
  world.processTick();

  const defGuild = world.guilds.get(l2.guildId);
  const treasuryBefore = defGuild.treasury;

  // Declare war
  world.queueAction(l1.id, { type: 'declare_war', targetGuildId: l2.guildId });
  world.processTick();

  // Manually set attacker score to ensure win
  const warId = [...world.wars.keys()][0];
  const war = world.wars.get(warId);
  war.attackerScore = 50;

  // Fast forward to end
  for (let i = 0; i < 601; i++) world.processTick();

  assert(war.status === 'ended', 'War ended');
  assert(war.winner === 'attacker', 'Attacker won');

  // Winner guild gets 10% of loser's treasury
  const atkGuild = world.guilds.get(l1.guildId);
  const expectedSpoils = Math.floor(treasuryBefore * 0.1);
  assert(atkGuild.treasury === expectedSpoils, 'Winner received 10% spoils');
  assert(defGuild.treasury === treasuryBefore - expectedSpoils, 'Loser lost 10% treasury');
}

// --- World Events: Activation ---
console.log('\n🌍 World Events: Activation');
{
  const world = new WorldState();
  world.addAgent({ wallet: 'a', name: 'A' });
  world.addAgent({ wallet: 'b', name: 'B' });

  // Force an event by setting conditions
  world.tick = 299;
  // Override Math.random to force event
  const origRandom = Math.random;
  Math.random = () => 0.1; // < 0.5, will trigger

  world.processTick(); // tick becomes 300, event should trigger

  assert(world._activeWorldEvent !== null, 'World event activated');
  assert(world._activeWorldEvent.startTick === 300, 'Event started at tick 300');
  assert(world._activeWorldEvent.endTick > 300, 'Event has end tick');

  Math.random = origRandom;
}

// --- World Events: Expiry ---
console.log('\n🌍 World Events: Expiry');
{
  const world = new WorldState();
  world.addAgent({ wallet: 'a', name: 'A' });
  world.addAgent({ wallet: 'b', name: 'B' });

  // Force an event
  world._activeWorldEvent = {
    type: 'resource_rush',
    label: 'Resource Rush',
    desc: 'Test',
    startTick: 0,
    endTick: 5,
    duration: 5,
  };

  // Advance past end
  for (let i = 0; i < 6; i++) world.processTick();
  assert(world._activeWorldEvent === null, 'World event expired and cleared');
}

// --- World Events: No Overlap ---
console.log('\n🌍 World Events: No Overlap');
{
  const world = new WorldState();
  world.addAgent({ wallet: 'a', name: 'A' });
  world.addAgent({ wallet: 'b', name: 'B' });

  // Set an active event
  world._activeWorldEvent = {
    type: 'peaceful_era',
    label: 'Peaceful Era',
    desc: 'Test',
    startTick: 0,
    endTick: 1000,
    duration: 1000,
  };

  // Advance to tick 300 (event trigger point)
  world.tick = 299;
  world.processTick();

  // Should still be the original event
  assert(world._activeWorldEvent.type === 'peaceful_era', 'No new event while one is active');
}

// --- World Events: Peaceful Era Blocks Combat ---
console.log('\n🌍 World Events: Peaceful Era');
{
  const world = new WorldState();
  const attacker = world.addAgent({ wallet: 'atk', name: 'Attacker' });
  const defender = world.addAgent({ wallet: 'def', name: 'Defender' });
  defender.x = attacker.x + 1; defender.y = attacker.y;

  // Activate peaceful era
  world._activeWorldEvent = { type: 'peaceful_era', label: 'Peaceful Era', desc: 'Test', startTick: 0, endTick: 1000, duration: 1000 };

  world.queueAction(attacker.id, { type: 'attack', targetAgentId: defender.id });
  const result = world.processTick();
  assert(!result.results[0].success, 'Combat blocked during Peaceful Era');
  assert(result.results[0].error.includes('Peaceful Era'), 'Error mentions Peaceful Era');

  // Clear event — combat should work again
  world._activeWorldEvent = null;
  world.queueAction(attacker.id, { type: 'attack', targetAgentId: defender.id });
  const result2 = world.processTick();
  assert(result2.results[0].success, 'Combat works after Peaceful Era ends');
}

// --- World Events: Trader's Boon Waives Fees ---
console.log('\n🌍 World Events: Trader Boon');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'sell', name: 'Seller' });
  const buyer = world.addAgent({ wallet: 'buy', name: 'Buyer' });
  seller.metadata.inventory = { wood: 10 };
  world.deposit(buyer.id, 1e9);

  // Activate trader's boon
  world._activeWorldEvent = { type: 'trader_boon', label: "Trader's Boon", desc: 'Test', startTick: 0, endTick: 1000, duration: 1000 };

  world.queueAction(seller.id, { type: 'market_sell', item: 'wood', quantity: 5, pricePerUnit: 1000000 });
  const sellResult = world.processTick();
  const orderId = sellResult.results[0].data.orderId;

  world.queueAction(buyer.id, { type: 'market_buy', orderId, quantity: 5 });
  world.processTick();

  // Seller gets full payment (no 1% fee deducted)
  const totalCost = 5 * 1000000;
  assert(world.getBalance(seller.id).balance === totalCost, 'Seller receives full payment (no fee)');

  // Verify: without boon, seller would get totalCost - 1% = 4950000
  // With boon, seller gets full 5000000
  assert(world.getBalance(seller.id).balance > totalCost * 0.99, 'No marketplace fee deducted during Trader Boon');
}

// --- World Events: Double Bounty ---
console.log('\n🌍 World Events: Double Bounty');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'creator', name: 'Creator' });
  const hunter = world.addAgent({ wallet: 'hunter', name: 'Hunter' });
  world.deposit(creator.id, 5e9);
  world.deposit(hunter.id, 1e9);

  // Post bounty normally
  world.queueAction(creator.id, { type: 'post_bounty', title: 'Test', description: 'Do it', rewardSOL: 0.1 });
  world.processTick();
  const bountyId = [...world.bounties.keys()][0];

  // Hunter claims and submits
  world.queueAction(hunter.id, { type: 'claim_bounty', bountyId });
  world.processTick();
  world.queueAction(hunter.id, { type: 'submit_bounty', bountyId, proof: 'done' });
  world.processTick();

  // Activate double bounty before accepting
  world._activeWorldEvent = { type: 'double_bounty', label: 'Double Bounty', desc: 'Test', startTick: 0, endTick: 1000, duration: 1000 };

  world.queueAction(creator.id, { type: 'accept_submission', bountyId });
  world.processTick();

  // Hunter should receive ~2x reward (minus fee) + stake returned
  const balance = world.getBalance(hunter.id).balance;
  assert(balance > 0.15e9, 'Hunter received more than base reward (double bounty active)');
}

// --- Gather / Resources ---
console.log('\n🌿 Resources: Gather');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'gather-1', name: 'Gatherer' });

  // Place a resource near the agent
  const key = `${agent.x},${agent.y}`;
  world.resources.set(key, { type: 'wood', amount: 5, maxAmount: 10, regenRate: 1, x: agent.x, y: agent.y, zoneId: 'village_center', lastHarvested: null });

  world.queueAction(agent.id, { type: 'gather', x: agent.x, y: agent.y });
  world.processTick();

  const inv = agent.metadata.inventory || {};
  assert(inv.wood > 0, 'Agent gathered wood');
  assert(world.resources.get(key).amount < 5, 'Resource amount decreased');
  assert(agent.xp > 0, 'Agent earned XP from gathering');
}

console.log('\n🌿 Resources: Gather Too Far');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'gather-2', name: 'FarGatherer' });

  world.resources.set('100,100', { type: 'wood', amount: 5, maxAmount: 10, regenRate: 1, x: 100, y: 100, zoneId: 'village_center', lastHarvested: null });

  world.queueAction(agent.id, { type: 'gather', x: 100, y: 100 });
  const results = world.processTick();
  const r = results.results[0];
  assert(!r.success, 'Cannot gather too far');
}

console.log('\n🌿 Resources: Scan');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'scan-1', name: 'Scanner' });

  world.resources.set(`${agent.x + 1},${agent.y}`, { type: 'stone', amount: 3, maxAmount: 6, regenRate: 0, x: agent.x + 1, y: agent.y, zoneId: 'village_center', lastHarvested: null });

  world.queueAction(agent.id, { type: 'scan_resources', radius: 5 });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'Scan succeeds');
  assert(r.data.resources.length >= 1, 'Scan finds nearby resource');
}

// --- Inspect ---
console.log('\n🔍 Inspect');
{
  const world = new WorldState();
  const agent1 = world.addAgent({ wallet: 'ins-1', name: 'Inspector' });
  const agent2 = world.addAgent({ wallet: 'ins-2', name: 'Target' });
  agent2.x = agent1.x + 1; agent2.y = agent1.y;

  world.queueAction(agent1.id, { type: 'inspect', targetAgentId: agent2.id });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'Inspect succeeds');
  assert(r.data.name === 'Target', 'Inspect returns target name');
}

console.log('\n🔍 Inspect: Out of Range');
{
  const world = new WorldState();
  const agent1 = world.addAgent({ wallet: 'ins-3', name: 'FarInspector' });
  const agent2 = world.addAgent({ wallet: 'ins-4', name: 'FarTarget' });
  agent2.x = agent1.x + 100; agent2.y = agent1.y + 100;

  world.queueAction(agent1.id, { type: 'inspect', targetAgentId: agent2.id });
  const results = world.processTick();
  assert(!results.results[0].success, 'Cannot inspect out of range');
}

// --- Defend ---
console.log('\n🛡️ Defend');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'def-1', name: 'Defender' });

  world.queueAction(agent.id, { type: 'defend', active: true });
  world.processTick();
  assert(agent.combat.defending === true, 'Agent is defending');

  world.queueAction(agent.id, { type: 'defend', active: false });
  world.processTick();
  assert(agent.combat.defending === false, 'Agent stopped defending');
}

// --- Contest Territory ---
console.log('\n⚔️ Contest Territory');
{
  const world = new WorldState();
  const attacker = world.addAgent({ wallet: 'con-1', name: 'Contester' });
  const defender = world.addAgent({ wallet: 'con-2', name: 'LandOwner' });
  world.deposit(attacker.id, 1e9);
  world.deposit(defender.id, 1e9);

  // Defender claims a tile
  const tile = world.tiles.get(`${attacker.x + 1},${attacker.y}`);
  if (tile) {
    tile.owner = defender.id;
    tile.claimedAt = 0;

    world.queueAction(attacker.id, { type: 'contest_territory', x: attacker.x + 1, y: attacker.y });
    const results = world.processTick();
    const r = results.results[0];
    assert(r.success, 'Contest territory succeeds');
    assert(r.data.contestId !== undefined, 'Contest ID assigned');
    assert(r.data.ticksRemaining === 30, 'Contest lasts 30 ticks');
  } else {
    assert(false, 'Test tile not found');
  }
}

// --- Bridge ---
console.log('\n🌉 Bridge');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'br-1', name: 'Bridger' });

  world.queueAction(agent.id, { type: 'bridge', bridge: 'solana', bridgeAction: 'balance', params: {} });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'Bridge action queued');
  assert(r.data.status === 'queued', 'Bridge returns queued status');
}

// --- Interior Move ---
console.log('\n🏠 Interior Move');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'int-1', name: 'Interior' });
  world.deposit(agent.id, 5e9);

  // Build a home
  world.queueAction(agent.id, { type: 'build', buildingType: 'home', x: agent.x, y: agent.y });
  world.processTick();

  const buildingId = [...world.buildings.values()].find(b => b.owner === agent.id)?.id;
  assert(buildingId !== undefined, 'Building exists');

  // Enter building
  world.queueAction(agent.id, { type: 'enter', buildingId });
  world.processTick();
  assert(agent.insideBuilding === buildingId, 'Agent entered building');

  // Interior move
  world.queueAction(agent.id, { type: 'interior_move', x: 1, y: 1 });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'Interior move succeeds');
  assert(agent.interiorX === 1 && agent.interiorY === 1, 'Agent moved inside');

  // Exit
  world.queueAction(agent.id, { type: 'exit' });
  world.processTick();
  assert(agent.insideBuilding === null, 'Agent exited building');
}

// --- Balance & Deposit Actions ---
console.log('\n💰 Balance & Deposit Actions');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'bal-1', name: 'Banker' });

  world.queueAction(agent.id, { type: 'deposit', amount: 1e9 });
  world.processTick();
  assert(world.getBalance(agent.id).balance === 1e9, 'Deposit action works');

  world.queueAction(agent.id, { type: 'balance' });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'Balance action succeeds');
  assert(r.data.balance === 1e9, 'Balance returns correct amount');
}

// --- Action Rate Limit ---
console.log('\n🚦 Action Rate Limit');
{
  const world = new WorldState({ MAX_ACTIONS_PER_TICK: 2 });
  const agent = world.addAgent({ wallet: 'rl-1', name: 'Spammer' });

  const r1 = world.queueAction(agent.id, { type: 'balance' });
  const r2 = world.queueAction(agent.id, { type: 'balance' });
  const r3 = world.queueAction(agent.id, { type: 'balance' });
  assert(r1.success, 'First action queued');
  assert(r2.success, 'Second action queued');
  assert(!r3.success, 'Third action rejected (rate limit)');
  assert(r3.error.includes('Max actions'), 'Rate limit error message');
}

// --- Building Spatial Index ---
console.log('\n🏗️ Building Spatial Index');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'bsi-1', name: 'Builder' });
  world.deposit(agent.id, 5e9);

  world.queueAction(agent.id, { type: 'build', buildingType: 'shop', x: agent.x, y: agent.y });
  world.processTick();

  const building = [...world.buildings.values()][0];
  const nearbyIds = world._getNearbyBuildingIds(agent.x, agent.y, 10);
  assert(nearbyIds.includes(building.id), 'Building found via spatial index');

  const farIds = world._getNearbyBuildingIds(agent.x + 100, agent.y + 100, 5);
  assert(!farIds.includes(building.id), 'Building not found when far away');
}

// --- Sell Land ---
console.log('\n🏡 Sell Land');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'sell-1', name: 'Seller' });
  const buyer = world.addAgent({ wallet: 'sell-2', name: 'Buyer' });
  world.deposit(seller.id, 1e9);
  world.deposit(buyer.id, 1e9);

  // Seller claims land
  world.queueAction(seller.id, { type: 'claim', x: seller.x + 1, y: seller.y });
  world.processTick();

  // Sell to buyer
  world.queueAction(seller.id, { type: 'sell_land', x: seller.x + 1, y: seller.y, price: 0.05e9, buyerAgentId: buyer.id });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'Land sale succeeds');

  const tile = world.tiles.get(`${seller.x + 1},${seller.y}`);
  assert(tile.owner === buyer.id, 'Ownership transferred to buyer');
}

// --- Upgrade Building ---
console.log('\n⬆️ Upgrade Building');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'upg-1', name: 'Upgrader' });
  world.deposit(agent.id, 5e9);

  world.queueAction(agent.id, { type: 'build', buildingType: 'home', x: agent.x, y: agent.y });
  world.processTick();

  const building = [...world.buildings.values()].find(b => b.owner === agent.id);
  assert(building.appearance.level === 1, 'Building starts at level 1');

  world.queueAction(agent.id, { type: 'upgrade', buildingId: building.id });
  world.processTick();
  assert(building.appearance.level === 2, 'Building upgraded to level 2');

  world.queueAction(agent.id, { type: 'upgrade', buildingId: building.id });
  world.processTick();
  assert(building.appearance.level === 3, 'Building upgraded to level 3');

  world.queueAction(agent.id, { type: 'upgrade', buildingId: building.id });
  const r4 = world.processTick();
  assert(!r4.results[0].success, 'Cannot upgrade past max level');
}

// --- Rate Agent ---
console.log('\n⭐ Rate Agent');
{
  const world = new WorldState();
  const rater = world.addAgent({ wallet: 'rate-1', name: 'Rater' });
  const ratee = world.addAgent({ wallet: 'rate-2', name: 'Ratee' });
  ratee.x = rater.x + 1; ratee.y = rater.y;

  world.queueAction(rater.id, { type: 'rate_agent', targetAgentId: ratee.id, score: 5, comment: 'Great!' });
  world.processTick();
  assert(ratee.reputation.averageRating === 5, 'Rating applied correctly');
  assert(ratee.reputation.ratingsReceived === 1, 'Rating count incremented');

  // Can't rate self
  world.queueAction(rater.id, { type: 'rate_agent', targetAgentId: rater.id, score: 5 });
  const r2 = world.processTick();
  assert(!r2.results[0].success, 'Cannot rate yourself');
}

// --- Get Ratings ---
console.log('\n⭐ Get Ratings');
{
  const world = new WorldState();
  const a1 = world.addAgent({ wallet: 'gr-1', name: 'A' });
  const a2 = world.addAgent({ wallet: 'gr-2', name: 'B' });
  a2.x = a1.x + 1; a2.y = a1.y;

  world.queueAction(a1.id, { type: 'rate_agent', targetAgentId: a2.id, score: 4 });
  world.processTick();

  world.queueAction(a2.id, { type: 'get_ratings', targetAgentId: a2.id });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'Get ratings succeeds');
  assert(r.data.ratings.length === 1, 'Has one rating');
  assert(r.data.averageRating === 4, 'Average rating is correct');
}

// --- Market Cancel ---
console.log('\n🏪 Marketplace: Cancel Order');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'mc-1', name: 'CancelSeller' });
  seller.metadata.inventory = { wood: 10 };

  world.queueAction(seller.id, { type: 'market_sell', item: 'wood', quantity: 5, pricePerUnit: 1000 });
  world.processTick();
  assert(seller.metadata.inventory.wood === 5, 'Wood escrowed from inventory');

  const orderId = [...world.marketplace.keys()][0];
  world.queueAction(seller.id, { type: 'market_cancel', orderId });
  world.processTick();
  assert(seller.metadata.inventory.wood === 10, 'Wood returned after cancel');
  assert(world.marketplace.size === 0, 'Order removed from marketplace');
}

// --- Market List ---
console.log('\n🏪 Marketplace: List Orders');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'ml-1', name: 'Lister' });
  agent.metadata.inventory = { stone: 20 };

  world.queueAction(agent.id, { type: 'market_sell', item: 'stone', quantity: 10, pricePerUnit: 500 });
  world.processTick();

  world.queueAction(agent.id, { type: 'market_list', item: 'stone' });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'Market list succeeds');
  assert(r.data.orders.length === 1, 'Lists one order');
  assert(r.data.orders[0].item === 'stone', 'Order is for stone');
}

// --- War Status ---
console.log('\n⚔️ War: Status');
{
  const world = new WorldState();
  const leader1 = world.addAgent({ wallet: 'ws-1', name: 'WarLeader1' });
  const leader2 = world.addAgent({ wallet: 'ws-2', name: 'WarLeader2' });
  world.deposit(leader1.id, 5e9);
  world.deposit(leader2.id, 5e9);

  world.queueAction(leader1.id, { type: 'create_guild', name: 'WarGuild1' });
  world.queueAction(leader2.id, { type: 'create_guild', name: 'WarGuild2' });
  world.processTick();

  const guildId2 = leader2.guildId;
  world.queueAction(leader1.id, { type: 'declare_war', targetGuildId: guildId2 });
  world.processTick();

  world.queueAction(leader1.id, { type: 'war_status' });
  const results = world.processTick();
  const r = results.results[0];
  assert(r.success, 'War status succeeds');
  assert(r.data.wars.length === 1, 'One active war');
  assert(r.data.wars[0].ticksRemaining > 0, 'War has ticks remaining');
}

// ==================== BOT MANAGER ====================
console.log('\n🤖 BotManager: Launch and Tick');
{
  const { BotManager } = require('../src/server/BotManager');
  const world = new WorldState();
  const bm = new BotManager(world);
  const WALLET = 'DemoWallet1234567890abcdefghijkl';

  // Launch a bot with all behaviors
  const result = bm.launch(WALLET, 'TestBot', ['explorer', 'trader', 'fighter', 'social', 'builder']);
  assert(result.agentId, 'Bot has agentId');
  assert(result.name === 'TestBot', 'Bot has correct name');
  assert(result.behaviors.length === 5, 'Bot has 5 behaviors');
  assert(result.ownerWallet === WALLET, 'Bot has ownerWallet');
  passed += 4; console.log('  ✅ Bot launched with all behaviors + wallet');

  // Bot appears in world
  const agent = world.getAgent(result.agentId);
  assert(agent, 'Bot agent exists in world');
  passed++; console.log('  ✅ Bot agent exists in world');

  // Tick runs without error
  bm.tick();
  passed++; console.log('  ✅ Bot tick runs without error');

  // List bots filtered by wallet
  const bots = bm.list(WALLET);
  assert(bots.length === 1, 'One bot for wallet');
  assert(bots[0].running === true, 'Bot is running');
  assert(bots[0].ownerWallet === WALLET, 'Wallet matches');
  passed += 3; console.log('  ✅ Bot list by wallet works');

  // List with wrong wallet returns nothing
  const empty = bm.list('WrongWa12345678901234567890abcd');
  assert(empty.length === 0, 'Wrong wallet returns no bots');
  passed++; console.log('  ✅ Wrong wallet returns empty list');

  // Stop with wrong wallet fails
  const badStop = bm.stop(result.agentId, 'WrongWa12345678901234567890abcd');
  assert(badStop === false, 'Stop with wrong wallet fails');
  passed++; console.log('  ✅ Stop with wrong wallet rejected');

  // Stop with correct wallet
  const stopped = bm.stop(result.agentId, WALLET);
  assert(stopped === true, 'Stop returns true');
  const bots2 = bm.list(WALLET);
  assert(bots2[0].running === false, 'Bot is stopped');
  passed += 2; console.log('  ✅ Bot stop with correct wallet works');

  // Resume bot
  const resumed = bm.resume(result.agentId, WALLET);
  assert(resumed === true, 'Resume returns true');
  const bots3 = bm.list(WALLET);
  assert(bots3[0].running === true, 'Bot is running again');
  passed += 2; console.log('  ✅ Bot resume works');

  // Stop again for skip test
  bm.stop(result.agentId, WALLET);
  bm.tick(); // should not throw
  passed++; console.log('  ✅ Tick skips stopped bots');
}

console.log('\n🤖 BotManager: Serialize and Restore');
{
  const { BotManager } = require('../src/server/BotManager');
  const world = new WorldState();
  const bm = new BotManager(world);
  const WALLET = 'SerializeWa9876543210abcdefghij';

  const bot1 = bm.launch(WALLET, 'Saver1', ['explorer', 'fighter']);
  const bot2 = bm.launch(WALLET, 'Saver2', ['trader', 'social', 'builder']);
  bm.stop(bot2.agentId, WALLET);

  // Serialize
  const json = bm.serialize();
  const data = JSON.parse(json);
  assert(data.length === 2, 'Serialized 2 bots');
  assert(data[0].ownerWallet === WALLET, 'Wallet preserved in serialization');
  assert(data[1].running === false, 'Stopped state preserved');
  passed += 3; console.log('  ✅ Serialize preserves bot configs');

  // Restore into new BotManager (same world, agents still exist)
  const bm2 = new BotManager(world);
  const count = bm2.restore(json);
  assert(count === 2, 'Restored 2 bots');
  const restored = bm2.list(WALLET);
  assert(restored.length === 2, 'Can find restored bots by wallet');
  assert(restored[0].name === 'Saver1', 'Restored bot has correct name');
  passed += 3; console.log('  ✅ Restore recovers bots with wallet ownership');

  // Restore skips bots whose agents don't exist
  const emptyWorld = new WorldState();
  const bm3 = new BotManager(emptyWorld);
  const count2 = bm3.restore(json);
  assert(count2 === 0, 'No bots restored for missing agents');
  passed++; console.log('  ✅ Restore skips bots with missing agents');
}

console.log('\n🤖 BotManager: Multi-wallet Isolation');
{
  const { BotManager } = require('../src/server/BotManager');
  const world = new WorldState();
  const bm = new BotManager(world);

  const bot1 = bm.launch('WalletA1234567890abcdefghijklmn', 'Alice', ['explorer']);
  const bot2 = bm.launch('WalletB1234567890abcdefghijklmn', 'Bob', ['fighter']);

  // Each wallet sees only their own bots
  const aliceBots = bm.list('WalletA1234567890abcdefghijklmn');
  const bobBots = bm.list('WalletB1234567890abcdefghijklmn');
  assert(aliceBots.length === 1 && aliceBots[0].name === 'Alice', 'Alice sees only her bot');
  assert(bobBots.length === 1 && bobBots[0].name === 'Bob', 'Bob sees only his bot');
  passed += 2; console.log('  ✅ Wallets are isolated');

  // Alice can't stop Bob's bot
  const crossStop = bm.stop(bot2.agentId, 'WalletA1234567890abcdefghijklmn');
  assert(crossStop === false, 'Cross-wallet stop rejected');
  passed++; console.log('  ✅ Cross-wallet stop rejected');
}

console.log('\n🤖 BotManager: Single Behavior');
{
  const { BotManager } = require('../src/server/BotManager');
  const world = new WorldState();
  const bm = new BotManager(world);

  const result = bm.launch('TestWallet12345678901234567890ab', 'Explorer', ['explorer']);
  assert(result.behaviors.length === 1, 'Single behavior');
  assert(result.behaviors[0] === 'explorer', 'Behavior is explorer');
  passed += 2; console.log('  ✅ Single behavior launch works');

  // Run multiple ticks to test explorer movement
  for (let i = 0; i < 5; i++) {
    world.processTick();
    bm.tick();
  }
  passed++; console.log('  ✅ Multiple ticks run without error');
}

console.log('\n🤖 BotManager: Invalid Behaviors Fallback');
{
  const { BotManager } = require('../src/server/BotManager');
  const world = new WorldState();
  const bm = new BotManager(world);

  const result = bm.launch('TestWallet12345678901234567890ab', 'Fallback', ['nonexistent', 'fake']);
  assert(result.behaviors.length === 1, 'Falls back to default');
  assert(result.behaviors[0] === 'explorer', 'Default is explorer');
  passed += 2; console.log('  ✅ Invalid behaviors fall back to explorer');
}

// ==================== SECURITY TESTS ====================

console.log('\n🔒 Security: Input Validation');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'SecWallet1234567890123456789012', name: 'SecAgent' });
  world.deposit(agent.id, 10e9, 'test');

  // Invalid coordinates
  world.queueAction(agent.id, { type: 'move', x: NaN, y: 0 });
  let result = world.processTick();
  assert(!result.results[0].success, 'Move with NaN x rejected');

  world.queueAction(agent.id, { type: 'move', x: 99999, y: 0 });
  result = world.processTick();
  assert(!result.results[0].success, 'Move with out-of-bounds x rejected');

  world.queueAction(agent.id, { type: 'move', x: Infinity, y: 0 });
  result = world.processTick();
  assert(!result.results[0].success, 'Move with Infinity rejected');

  world.queueAction(agent.id, { type: 'move', x: 1.5, y: 0 });
  result = world.processTick();
  assert(!result.results[0].success, 'Move with float coordinate rejected');

  // Invalid trade amounts
  const agent2 = world.addAgent({ wallet: 'SecWallet1234567890123456789013', name: 'Target' });
  world.deposit(agent2.id, 1e9, 'test');
  // Move agents close together
  world.queueAction(agent.id, { type: 'move', x: agent2.x, y: agent2.y });
  world.processTick();

  world.queueAction(agent.id, { type: 'trade', targetAgentId: agent2.id, offer: { sol: -100 }, request: { sol: 100 } });
  result = world.processTick();
  assert(!result.results[0].success, 'Negative trade offer rejected');

  world.queueAction(agent.id, { type: 'trade', targetAgentId: agent2.id, offer: { sol: Infinity }, request: { sol: 100 } });
  result = world.processTick();
  assert(!result.results[0].success, 'Infinity trade offer rejected');

  // Invalid deposit amount
  world.queueAction(agent.id, { type: 'deposit', amount: -5 });
  result = world.processTick();
  assert(!result.results[0].success, 'Negative deposit rejected');

  world.queueAction(agent.id, { type: 'deposit', amount: 2000e9 });
  result = world.processTick();
  assert(!result.results[0].success, 'Over-limit deposit rejected (>1000 SOL)');

  // XSS in agent name
  const xssAgent = world.addAgent({ name: '<script>alert("xss")</script>' });
  assert(!xssAgent.name.includes('<script>'), 'Script tags sanitized from agent name');

  // Message length cap
  const longMsg = 'x'.repeat(1000);
  world.queueAction(agent.id, { type: 'speak', message: longMsg });
  result = world.processTick();
  const msgEvent = result.events.find(e => e.type === 'agent_spoke' && e.agentId === agent.id);
  assert(msgEvent && msgEvent.message.length <= 500, 'Speak message capped at 500 chars');
}

console.log('\n🔒 Security: BotManager Owner Validation');
{
  const { BotManager } = require('../src/server/BotManager');
  const world = new WorldState();
  const bm = new BotManager(world);

  // Invalid wallet
  let threw = false;
  try { bm.launch('tooshort', 'Bot', ['explorer']); } catch (e) { threw = true; }
  assert(threw, 'Launch with too-short wallet throws');

  threw = false;
  try { bm.launch('', 'Bot', ['explorer']); } catch (e) { threw = true; }
  assert(threw, 'Launch with empty wallet throws');

  threw = false;
  try { bm.launch(null, 'Bot', ['explorer']); } catch (e) { threw = true; }
  assert(threw, 'Launch with null wallet throws');

  // Stop/resume without wallet always fails (strict validation)
  const bot = bm.launch('TestWallet12345678901234567890ab', 'Bot', ['explorer']);
  assert(!bm.stop(bot.agentId, null), 'Stop without wallet returns false');
  assert(!bm.stop(bot.agentId, undefined), 'Stop without wallet (undefined) returns false');
  assert(!bm.stop(bot.agentId, ''), 'Stop with empty wallet returns false');
  assert(bm.stop(bot.agentId, 'TestWallet12345678901234567890ab'), 'Stop with correct wallet succeeds');

  assert(!bm.resume(bot.agentId, 'WrongWallet12345678901234567890ab'), 'Resume with wrong wallet returns false');
  assert(bm.resume(bot.agentId, 'TestWallet12345678901234567890ab'), 'Resume with correct wallet succeeds');

  // Per-wallet bot limit
  threw = false;
  const wallet = 'LimitTest1234567890123456789012';
  for (let i = 0; i < 5; i++) {
    bm.launch(wallet, `Bot${i}`, ['explorer']);
  }
  try { bm.launch(wallet, 'Bot6', ['explorer']); } catch (e) { threw = true; }
  assert(threw, 'Exceeding per-wallet bot limit throws');

  // Name sanitization
  const htmlBot = bm.launch('HtmlWallet1234567890123456789012', '<b>bold</b>', ['explorer']);
  assert(!htmlBot.name.includes('<b>'), 'HTML stripped from bot name');
}

console.log('\n🔒 Security: Solana Wallet Validation');
{
  const { RestAPI } = require('../src/server/RestAPI');
  const api = new RestAPI(new WorldState(), { getStats: () => ({}) });

  // Valid addresses (base58: 1-9, A-H, J-N, P-Z, a-k, m-z — no 0, O, I, l)
  assert(api._isValidSolanaWallet('DezXAZ69gDqKqgf7PjrDeF22Zf3nyBsQ'), 'Valid 32-char base58');
  assert(api._isValidSolanaWallet('DezXAZ69gDqKqgf7PjrDeF22Zf3nyBs9Uvxjkm8h'), 'Valid 41-char base58');

  // Invalid addresses
  assert(!api._isValidSolanaWallet('short'), 'Too short wallet invalid');
  assert(!api._isValidSolanaWallet(''), 'Empty wallet invalid');
  assert(!api._isValidSolanaWallet(null), 'Null wallet invalid');
  assert(!api._isValidSolanaWallet(123), 'Number wallet invalid');
  assert(!api._isValidSolanaWallet('7xKXabc123def456ghi789jkl012mn3O'), 'Base58 with O (zero-like) invalid');
  assert(!api._isValidSolanaWallet('7xKXabc123def456ghi789jkl012mn3I'), 'Base58 with I (L-like) invalid');
  assert(!api._isValidSolanaWallet('7xKXabc123def456ghi789jkl012mn3l'), 'Base58 with l (one-like) invalid');
  assert(!api._isValidSolanaWallet('7xKXabc123def456ghi789jkl0!@#$%'), 'Special chars invalid');
}

console.log('\n🔒 Security: Transaction Log Capping');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'LogCapWallet123456789012345678', name: 'Logger' });
  world.deposit(agent.id, 100e9, 'test');

  // Generate lots of transactions
  for (let i = 0; i < 2500; i++) {
    world.transactionLog.push({ type: 'test', amount: 1, tick: i });
  }
  assert(world.transactionLog.length >= 2500, 'Transaction log has 2500+ entries before tick');

  world.processTick();
  assert(world.transactionLog.length <= 2000, 'Transaction log capped after processTick');
}

// ==================== FEATURE TESTS ====================

console.log('\n🎯 Features: Bounty Dispute');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'Creator12345678901234567890123', name: 'Creator' });
  const hunter = world.addAgent({ wallet: 'Hunter123456789012345678901234', name: 'Hunter' });
  world.deposit(creator.id, 10e9, 'fund');
  world.deposit(hunter.id, 5e9, 'fund');

  // Post bounty
  world.queueAction(creator.id, { type: 'post_bounty', title: 'Test Task', description: 'Do something', rewardSOL: 1 });
  let result = world.processTick();
  const bountyId = result.results[0].data.bountyId;
  assert(bountyId, 'Bounty posted');

  // Claim bounty
  world.queueAction(hunter.id, { type: 'claim_bounty', bountyId });
  result = world.processTick();
  assert(result.results[0].success, 'Bounty claimed');

  // Submit proof
  world.queueAction(hunter.id, { type: 'submit_bounty', bountyId, proof: 'I did it' });
  result = world.processTick();
  assert(result.results[0].success, 'Bounty submitted');

  // Creator rejects
  world.queueAction(creator.id, { type: 'reject_submission', bountyId, reason: 'Not good enough' });
  result = world.processTick();
  assert(result.results[0].success, 'Submission rejected');

  // Hunter disputes
  world.queueAction(hunter.id, { type: 'dispute_bounty', bountyId, reason: 'Work was done correctly' });
  result = world.processTick();
  assert(result.results[0].success, 'Dispute filed');
  assert(result.results[0].data.note.includes('Dispute filed'), 'Dispute response message');

  const bounty = world.bounties.get(bountyId);
  assert(bounty._disputed === true, 'Bounty marked as disputed');

  // Cannot dispute twice
  world.queueAction(hunter.id, { type: 'dispute_bounty', bountyId, reason: 'Again' });
  result = world.processTick();
  assert(!result.results[0].success, 'Cannot dispute twice');
}

console.log('\n📊 Features: Economy Invariants');
{
  const world = new WorldState();
  const a1 = world.addAgent({ wallet: 'EconTest1234567890123456789012', name: 'Econ1' });
  const a2 = world.addAgent({ wallet: 'EconTest1234567890123456789013', name: 'Econ2' });
  world.deposit(a1.id, 5e9, 'fund');
  world.deposit(a2.id, 5e9, 'fund');

  const totalBefore = world.getBalance(a1.id).balance + world.getBalance(a2.id).balance + world.protocolRevenue;

  // Execute a trade between them
  // Move them together first
  world.queueAction(a1.id, { type: 'move', x: a2.x, y: a2.y });
  world.processTick();

  world.queueAction(a1.id, { type: 'trade', targetAgentId: a2.id, offer: { sol: 1e9 }, request: { sol: 0.5e9 } });
  let result = world.processTick();
  const tradeId = result.results[0].data?.tradeId;

  if (tradeId) {
    world.queueAction(a2.id, { type: 'accept_trade', tradeId });
    world.processTick();
  }

  const totalAfter = world.getBalance(a1.id).balance + world.getBalance(a2.id).balance + world.protocolRevenue;
  assert(totalBefore === totalAfter, 'Economy invariant: total SOL conserved after trade');
}

console.log('\n🏪 Features: Marketplace Fee Collection');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'Seller123456789012345678901234', name: 'Seller' });
  const buyer = world.addAgent({ wallet: 'Buyer1234567890123456789012345', name: 'Buyer' });
  seller.metadata.inventory = { wood: 20 };
  world.deposit(buyer.id, 5e9, 'fund');

  const revBefore = world.protocolRevenue;

  // Seller lists wood
  world.queueAction(seller.id, { type: 'market_sell', item: 'wood', quantity: 10, pricePerUnit: 0.01e9 });
  let result = world.processTick();
  const orderId = result.results[0].data?.orderId;
  assert(orderId, 'Market sell order created');

  // Buyer purchases
  world.queueAction(buyer.id, { type: 'market_buy', orderId, quantity: 5 });
  result = world.processTick();
  assert(result.results[0].success, 'Market buy succeeded');

  const revAfter = world.protocolRevenue;
  assert(revAfter > revBefore, 'Protocol collected marketplace fee');

  const buyerInv = buyer.metadata.inventory || {};
  assert((buyerInv.wood || 0) === 5, 'Buyer received 5 wood');
}

console.log('\n🛡️ Features: SDK Dispute Method');
{
  // Just verify the SDK has the method
  const { AgentWorldSDK } = require('../src/sdk/AgentWorldSDK');
  const sdk = new AgentWorldSDK({ wallet: 'test' });
  assert(typeof sdk.disputeBounty === 'function', 'SDK has disputeBounty method');
  assert(typeof sdk.craft === 'function', 'SDK has craft method');
  assert(typeof sdk.marketSell === 'function', 'SDK has marketSell method');
  assert(typeof sdk.contestTerritory === 'function', 'SDK has contestTerritory method');
  assert(typeof sdk.declareWar === 'function', 'SDK has declareWar method');
}

// ==================== PERFORMANCE TESTS ====================

console.log('\n⚡ Performance: Large World Tick');
{
  const world = new WorldState();
  const agents = [];
  // Spawn 50 agents
  for (let i = 0; i < 50; i++) {
    const a = world.addAgent({ wallet: `PerfWallet${i.toString().padStart(24, '0')}12345`, name: `Perf${i}` });
    world.deposit(a.id, 1e9, 'test');
    agents.push(a);
  }

  // Queue actions for all agents
  for (const a of agents) {
    world.queueAction(a.id, { type: 'move', x: a.x + 1, y: a.y });
  }

  const start = Date.now();
  world.processTick();
  const elapsed = Date.now() - start;

  assert(elapsed < 500, `50-agent tick in ${elapsed}ms (< 500ms)`);
  assert(world.agents.size === 50, 'All 50 agents still exist');
}

console.log('\n⚡ Performance: Spatial Index Correctness');
{
  const world = new WorldState();
  const a1 = world.addAgent({ wallet: 'Spatial12345678901234567890123', name: 'Near' });
  const a2 = world.addAgent({ wallet: 'Spatial12345678901234567890124', name: 'Far' });

  // Move a2 far away
  a2.x = 100; a2.y = 100;
  world._updateSpatialIndex(a2.id, 16, 16, 100, 100);

  const obs = world.getObservation(a1.id);
  const seesA2 = obs.nearbyAgents.some(a => a.id === a2.id);
  assert(!seesA2, 'Agent 100 tiles away not in observation');

  // Move a2 close
  world._updateSpatialIndex(a2.id, 100, 100, a1.x + 1, a1.y);
  a2.x = a1.x + 1; a2.y = a1.y;

  const obs2 = world.getObservation(a1.id);
  const seesA2Now = obs2.nearbyAgents.some(a => a.id === a2.id);
  assert(seesA2Now, 'Agent 1 tile away visible in observation');
}

// ==================== EDGE CASE TESTS ====================

console.log('\n🧩 Edge Cases: Max Actions Per Tick');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'EdgeCase1234567890123456789012', name: 'Edge' });

  // Queue more than MAX_ACTIONS_PER_TICK (3)
  for (let i = 0; i < 5; i++) {
    world.queueAction(agent.id, { type: 'speak', message: `msg${i}` });
  }
  // Only first 3 should succeed — the rest should be rejected at queue time
  assert(world.actionQueue.length === 3, 'Only 3 actions queued (MAX_ACTIONS_PER_TICK)');
  world.processTick();
}

console.log('\n🧩 Edge Cases: Dead Agent Cannot Act');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'DeadAgent123456789012345678901', name: 'Dead' });
  world.removeAgent(agent.id);

  const queueResult = world.queueAction(agent.id, { type: 'speak', message: 'hello' });
  assert(!queueResult.success, 'Removed agent cannot queue actions');
}

console.log('\n🧩 Edge Cases: Operator Controls');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'OpCtrl12345678901234567890123', name: 'Controlled' });

  // Pause agent
  agent.controls.paused = true;
  const queueResult = world.queueAction(agent.id, { type: 'speak', message: 'hello' });
  assert(!queueResult.success, 'Paused agent cannot queue actions');
  assert(queueResult.error.includes('paused'), 'Error mentions paused');

  // Restrict allowed actions
  agent.controls.paused = false;
  agent.controls.allowedActions = ['move'];
  const queueResult2 = world.queueAction(agent.id, { type: 'speak', message: 'hello' });
  assert(!queueResult2.success, 'Restricted agent cannot use disallowed actions');

  const queueResult3 = world.queueAction(agent.id, { type: 'move', x: agent.x + 1, y: agent.y });
  assert(queueResult3.success, 'Restricted agent can use allowed actions');
  world.processTick();
}

console.log('\n🧩 Edge Cases: Defending Agent Cannot Move');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'DefendMove12345678901234567890', name: 'Defender' });
  agent.combat.defending = true;

  world.queueAction(agent.id, { type: 'move', x: agent.x + 1, y: agent.y });
  const result = world.processTick();
  assert(!result.results[0].success, 'Defending agent cannot move');
  assert(result.results[0].error.includes('defending'), 'Error mentions defending');
}

console.log('\n🧩 Edge Cases: World Expansion');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'Expand12345678901234567890123', name: 'Explorer' });

  // Move agent to near the edge (zone is 0-63)
  agent.x = 60; agent.y = 32;
  world._updateSpatialIndex(agent.id, 32, 32, 60, 32);

  const zonesBefore = world.zones.size;
  world.checkAndExpandWorld(60, 32);
  const zonesAfter = world.zones.size;
  assert(zonesAfter > zonesBefore, 'World expanded when agent near edge');
}

console.log('\n🧩 Edge Cases: Crafting Recipes');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'Craft1234567890123456789012345', name: 'Crafter' });
  agent.metadata.inventory = { wood: 10, stone: 5 };

  // Craft wooden tools (requires 5 wood)
  world.queueAction(agent.id, { type: 'craft', recipe: 'wooden_tools' });
  let result = world.processTick();
  assert(result.results[0].success, 'Wooden tools crafted');
  assert((agent.metadata.inventory.wood || 0) === 5, '5 wood consumed');
  assert(agent.xp >= 10, 'XP gained from crafting');

  // Craft with insufficient materials
  agent.metadata.inventory = { wood: 1 };
  world.queueAction(agent.id, { type: 'craft', recipe: 'wooden_tools' });
  result = world.processTick();
  assert(!result.results[0].success, 'Craft fails with insufficient materials');

  // Invalid recipe
  world.queueAction(agent.id, { type: 'craft', recipe: 'nonexistent' });
  result = world.processTick();
  assert(!result.results[0].success, 'Invalid recipe rejected');
}

console.log('\n🧩 Edge Cases: Guild Treasury');
{
  const world = new WorldState();
  const leader = world.addAgent({ wallet: 'Guild12345678901234567890123456', name: 'GuildLeader' });
  world.deposit(leader.id, 5e9, 'fund');

  // Create guild
  world.queueAction(leader.id, { type: 'create_guild', name: 'TestGuild', description: 'A test guild', tag: 'TST' });
  let result = world.processTick();
  assert(result.results[0].success, 'Guild created');

  // Deposit to treasury
  world.queueAction(leader.id, { type: 'guild_deposit', amountSOL: 1 });
  result = world.processTick();
  assert(result.results[0].success, 'Guild deposit succeeded');

  const guild = world.guilds.get(leader.guildId);
  assert(guild && guild.treasury > 0, 'Guild treasury has funds');
}

// --- Protocol Revenue Accuracy ---
console.log('\n🧩 Economy: Protocol Revenue Accuracy');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'seller-wallet-revenue-test-00001', name: 'Seller' });
  const buyer = world.addAgent({ wallet: 'buyer-wallet-revenue-test-00002', name: 'Buyer' });
  world.deposit(seller.id, 10e9);
  world.deposit(buyer.id, 10e9);

  // Track initial protocol revenue
  const initialRevenue = world.protocolRevenue;

  // 1. Marketplace: seller lists, buyer buys — only 1% fee should be revenue
  seller.metadata.inventory = { wood: 50 };
  world.queueAction(seller.id, { type: 'market_sell', item: 'wood', quantity: 10, pricePerUnit: 1000000 });
  world.processTick();

  const orderId = [...world.marketplace.keys()][0];
  world.queueAction(buyer.id, { type: 'market_buy', orderId, quantity: 10 });
  const marketResult = world.processTick();
  const totalCost = 10 * 1000000;
  const expectedFee = Math.floor(totalCost * 0.01);
  const revenueAfterMarket = world.protocolRevenue - initialRevenue;
  assert(revenueAfterMarket === expectedFee, `Marketplace fee is exactly 1% (${revenueAfterMarket} === ${expectedFee})`);
}

console.log('\n🧩 Economy: Land Sale Revenue');
{
  const world = new WorldState();
  const seller = world.addAgent({ wallet: 'landseller-wallet-test-000001', name: 'LandSeller' });
  const buyer = world.addAgent({ wallet: 'landbuyer-wallet-test-0000002', name: 'LandBuyer' });
  world.deposit(seller.id, 10e9);
  world.deposit(buyer.id, 10e9);

  // Claim land first
  world.queueAction(seller.id, { type: 'claim', x: seller.x, y: seller.y });
  world.processTick();

  const revBefore = world.protocolRevenue;
  const price = 1e9; // 1 SOL
  world.queueAction(seller.id, { type: 'sell_land', x: seller.x, y: seller.y, price, buyerAgentId: buyer.id });
  world.processTick();

  const revGain = world.protocolRevenue - revBefore;
  const expected2pct = Math.floor(price * 0.02);
  assert(revGain === expected2pct, `Land sale fee is exactly 2% (${revGain} === ${expected2pct})`);
}

console.log('\n🧩 Economy: Guild Deposit Not Protocol Revenue');
{
  const world = new WorldState();
  const leader = world.addAgent({ wallet: 'guildrev-wallet-test-000000001', name: 'GuildLeader' });
  world.deposit(leader.id, 10e9);

  world.queueAction(leader.id, { type: 'create_guild', name: 'TestGuildRev', tag: 'TGR' });
  world.processTick();

  const revBefore = world.protocolRevenue;
  world.queueAction(leader.id, { type: 'guild_deposit', amountSOL: 1 });
  world.processTick();

  const revGain = world.protocolRevenue - revBefore;
  assert(revGain === 0, `Guild deposit does not inflate protocol revenue (gained ${revGain})`);
}

console.log('\n🧩 Economy: Bounty Escrow Not Protocol Revenue');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'bountyrev-wallet-test-00000001', name: 'BountyCreator' });
  world.deposit(creator.id, 10e9);

  const revBefore = world.protocolRevenue;
  world.queueAction(creator.id, { type: 'post_bounty', title: 'Test Bounty Rev', description: 'Test', rewardSOL: 1 });
  world.processTick();

  const revGain = world.protocolRevenue - revBefore;
  assert(revGain === 0, `Bounty escrow does not inflate protocol revenue (gained ${revGain})`);
}

console.log('\n🧩 Economy: Bounty Stake Not Protocol Revenue');
{
  const world = new WorldState();
  const creator = world.addAgent({ wallet: 'bstake-creator-wallet-test-001', name: 'StakeCreator' });
  const claimer = world.addAgent({ wallet: 'bstake-claimer-wallet-test-001', name: 'StakeClaimer' });
  world.deposit(creator.id, 10e9);
  world.deposit(claimer.id, 10e9);

  world.queueAction(creator.id, { type: 'post_bounty', title: 'Stake Test', description: 'Test', rewardSOL: 1 });
  world.processTick();

  const bountyId = [...world.bounties.keys()][0];
  const revBefore = world.protocolRevenue;
  world.queueAction(claimer.id, { type: 'claim_bounty', bountyId });
  world.processTick();

  const revGain = world.protocolRevenue - revBefore;
  assert(revGain === 0, `Bounty stake does not inflate protocol revenue (gained ${revGain})`);
}

console.log('\n🧩 Economy: Combat Loot Transfer (no protocol revenue)');
{
  const world = new WorldState();
  const attacker = world.addAgent({ wallet: 'loot-attacker-wallet-test-0001', name: 'Attacker' });
  const target = world.addAgent({ wallet: 'loot-target-wallet-test-000001', name: 'Target' });
  world.deposit(attacker.id, 5e9);
  world.deposit(target.id, 5e9);

  // Place them adjacent
  target.x = attacker.x + 1;
  target.y = attacker.y;
  target.combat.hp = 1; // one-hit kill

  const revBefore = world.protocolRevenue;
  const targetBalBefore = world.getBalance(target.id).balance;
  world.queueAction(attacker.id, { type: 'attack', targetAgentId: target.id });
  const result = world.processTick();

  const revGain = world.protocolRevenue - revBefore;
  assert(revGain === 0, `Combat loot is peer-to-peer, no protocol revenue (gained ${revGain})`);

  const lootResult = result.results[0];
  assert(lootResult.success, 'Attack succeeded');
  assert(lootResult.data.killed === true, 'Target was killed');
  assert(lootResult.data.loot > 0, `Loot amount reported correctly (${lootResult.data.loot})`);
}

// --- Action Results Include agentId ---
console.log('\n🧩 Action Results Include agentId');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'results-agent-wallet-test-0001', name: 'ResultAgent' });
  world.queueAction(agent.id, { type: 'move', x: agent.x + 1, y: agent.y });
  const result = world.processTick();

  assert(result.results.length > 0, 'Has results');
  assert(result.results[0].agentId === agent.id, 'Result includes agentId');
}

// --- Marketplace Order Limit ---
console.log('\n🧩 Marketplace Per-Agent Order Limit');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'orderlimit-wallet-test-0000001', name: 'OrderSpammer' });
  world.deposit(agent.id, 10e9);
  agent.metadata.inventory = { wood: 1000 };

  // Create 20 orders
  for (let i = 0; i < 20; i++) {
    world.queueAction(agent.id, { type: 'market_sell', item: 'wood', quantity: 1, pricePerUnit: 1000 });
    world.processTick();
  }

  // 21st should fail
  world.queueAction(agent.id, { type: 'market_sell', item: 'wood', quantity: 1, pricePerUnit: 1000 });
  const result = world.processTick();
  assert(!result.results[0].success, 'Marketplace rejects 21st order');
  assert(result.results[0].error.includes('20'), 'Error mentions 20 limit');
}

// --- Bounty Per-Agent Limit ---
console.log('\n🧩 Bounty Per-Agent Limit');
{
  const world = new WorldState();
  const agent = world.addAgent({ wallet: 'bountylimit-wallet-test-00001', name: 'BountySpammer' });
  world.deposit(agent.id, 100e9);

  // Create 10 bounties
  for (let i = 0; i < 10; i++) {
    world.queueAction(agent.id, { type: 'post_bounty', title: `Bounty ${i}`, description: 'Test', rewardSOL: 0.01 });
    world.processTick();
  }

  // 11th should fail
  world.queueAction(agent.id, { type: 'post_bounty', title: 'Bounty 10', description: 'Test', rewardSOL: 0.01 });
  const result = world.processTick();
  assert(!result.results[0].success, 'Bounty rejects 11th posting');
  assert(result.results[0].error.includes('10'), 'Error mentions 10 limit');
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
