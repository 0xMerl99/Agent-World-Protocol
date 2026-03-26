/**
 * Trading Agent — A demo agent that uses bridges to interact with Solana.
 * 
 * This agent:
 * - Checks its wallet balance via the Solana bridge
 * - Gets token prices via Jupiter
 * - Executes simulated swaps
 * - Shares market intel with nearby agents
 * - Launches tokens on pump.fun (simulated)
 * 
 * Usage:
 *   node examples/trading-agent.js
 *   node examples/trading-agent.js --wallet <REAL_SOLANA_PUBKEY>
 */

const { AgentWorldSDK } = require('../src/sdk/AgentWorldSDK');

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const SERVER_URL = getArg('--server', 'ws://localhost:3000');
const AGENT_NAME = getArg('--name', 'Trader-' + Math.random().toString(36).slice(2, 6));
const WALLET = getArg('--wallet', 'demo-trader-' + Math.random().toString(36).slice(2, 10));

// Trading state
const state = {
  balanceChecked: false,
  pricesChecked: false,
  tradesMade: 0,
  tokensLaunched: 0,
  tickCount: 0,
  knownPrices: {},
};

async function main() {
  const agent = new AgentWorldSDK({
    serverUrl: SERVER_URL,
    wallet: WALLET,
    name: AGENT_NAME,
  });

  agent.on('connected', (msg) => {
    console.log(`\n💰 ${AGENT_NAME} has entered the world as a trader!`);
    console.log(`   Wallet: ${WALLET}`);
    console.log(`   Position: (${msg.agent.x}, ${msg.agent.y})`);
    console.log('');
  });

  // Handle bridge results
  agent.on('message', (msg) => {
    if (msg.type === 'bridge_result') {
      handleBridgeResult(agent, msg);
    }
  });

  agent.on('observation', (obs) => {
    state.tickCount++;
    tradingLogic(agent, obs);
  });

  agent.on('error', (err) => {
    console.error(`   ❌ Error: ${err.message}`);
  });

  try {
    await agent.connect();
  } catch (err) {
    console.error(`Failed to connect: ${err.message}`);
    process.exit(1);
  }
}

function tradingLogic(agent, obs) {
  if (!obs || !obs.self) return;

  // Tick 3: Check wallet balance
  if (state.tickCount === 3 && !state.balanceChecked) {
    console.log('   📊 Checking wallet balance...');
    agent.bridge('solana', 'getBalance', { wallet: WALLET });
    state.balanceChecked = true;
  }

  // Tick 5: Get SOL price
  if (state.tickCount === 5) {
    console.log('   📊 Fetching SOL price...');
    agent.bridge('jupiter', 'price', { token: 'SOL' });
  }

  // Tick 7: Get available tokens
  if (state.tickCount === 7) {
    console.log('   📊 Listing available tokens...');
    agent.bridge('jupiter', 'tokens', {});
  }

  // Tick 10: Get a swap quote
  if (state.tickCount === 10) {
    console.log('   📊 Getting swap quote: 0.1 SOL → USDC...');
    agent.bridge('jupiter', 'quote', {
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: 100000000, // 0.1 SOL in lamports
    });
  }

  // Tick 13: Execute a simulated swap
  if (state.tickCount === 13) {
    console.log('   🔄 Executing simulated swap: 0.05 SOL → USDC...');
    agent.bridge('jupiter', 'swap', {
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: 50000000, // 0.05 SOL
    });
    state.tradesMade++;
  }

  // Tick 16: Launch a token on pump.fun
  if (state.tickCount === 16) {
    console.log('   🚀 Launching token on pump.fun...');
    agent.bridge('pumpfun', 'create', {
      name: 'Agent World Token',
      symbol: 'AWP',
      description: 'The native token of Agent World Protocol. Created by an autonomous AI agent.',
      initialBuySOL: 0.1,
    });
    state.tokensLaunched++;
  }

  // Tick 20: Check trending on pump.fun
  if (state.tickCount === 20) {
    console.log('   📊 Checking pump.fun trending...');
    agent.bridge('pumpfun', 'trending', { limit: 5 });
  }

  // Share intel with nearby agents
  if (state.tickCount > 10 && state.tickCount % 8 === 0 && obs.nearbyAgents.length > 0) {
    const messages = [
      `SOL looking strong today. ${state.tradesMade} trades executed so far.`,
      `Just checked the markets. Anyone want to trade?`,
      `${state.tokensLaunched} tokens launched. The agent economy is growing.`,
      `Pro tip: always check prices before swapping.`,
      `Bridge stats: ${state.tradesMade} swaps, ${state.tokensLaunched} launches.`,
    ];
    const msg = messages[Math.floor(Math.random() * messages.length)];
    agent.speak(msg);
    console.log(`   💬 ${msg}`);
  }

  // Wander slowly
  if (state.tickCount % 4 === 0) {
    const dx = Math.floor(Math.random() * 3) - 1;
    const dy = Math.floor(Math.random() * 3) - 1;
    agent.move(obs.self.x + dx, obs.self.y + dy);
  }

  // Periodic status
  if (state.tickCount % 15 === 0) {
    console.log(`   📍 Tick ${obs.tick} | Pos: (${obs.self.x}, ${obs.self.y}) | Trades: ${state.tradesMade} | Launches: ${state.tokensLaunched}`);
  }
}

function handleBridgeResult(agent, msg) {
  const { bridge, action, result } = msg;

  if (!result.success) {
    console.log(`   ❌ Bridge ${bridge}/${action} failed: ${result.error}`);
    return;
  }

  switch (bridge) {
    case 'solana':
      if (action === 'getBalance') {
        console.log(`   💰 Balance: ${result.data.balanceSOL} SOL`);
      }
      break;

    case 'jupiter':
      if (action === 'price') {
        console.log(`   💵 ${result.data.token} price: $${result.data.price}`);
        state.knownPrices[result.data.token] = result.data.price;
      }
      if (action === 'quote') {
        console.log(`   📊 Quote: ${result.data.inAmount} → ${result.data.outAmount} (impact: ${result.data.priceImpactPct}%)`);
        if (result.data.platformFee) {
          console.log(`   📊 Protocol fee: ${result.data.platformFee.amount} lamports (${result.data.platformFee.feeBps}bps)`);
        }
      }
      if (action === 'swap') {
        console.log(`   ✅ Swap ${result.data.status}: ${JSON.stringify(result.data.quote?.inAmount)} → ${JSON.stringify(result.data.quote?.outAmount)}`);
      }
      if (action === 'tokens') {
        const tokens = result.data.tokens.map(t => t.symbol).join(', ');
        console.log(`   📋 Available tokens: ${tokens}`);
      }
      break;

    case 'pumpfun':
      if (action === 'create') {
        console.log(`   🚀 Token launched! ${result.data.token.name} ($${result.data.token.symbol}) — ${result.data.status}`);
      }
      if (action === 'trending') {
        const trending = result.data.tokens.slice(0, 3).map(t => `${t.symbol} ($${(t.marketCap/1000).toFixed(0)}k)`).join(', ');
        console.log(`   🔥 Trending: ${trending}`);
      }
      break;
  }
}

main();
