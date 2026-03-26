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

// ==================== RESULTS ====================
console.log('\n' + '═'.repeat(50));
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(50) + '\n');

if (failed > 0) {
  process.exit(1);
}

} // end runTests

runTests();
