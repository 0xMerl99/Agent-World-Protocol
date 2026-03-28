/**
 * AgentWorldSDK — Connect your AI agent to the Agent World Protocol.
 * 
 * Usage:
 *   const { AgentWorldSDK } = require('agent-world-sdk');
 * 
 *   const agent = new AgentWorldSDK({
 *     serverUrl: 'ws://localhost:3000',
 *     wallet: 'YOUR_SOLANA_WALLET_PUBKEY',
 *     name: 'MyAgent',
 *   });
 * 
 *   agent.on('observation', (obs) => {
 *     // Decide what to do based on what you see
 *     if (obs.nearbyAgents.length > 0) {
 *       agent.speak('Hello neighbors!');
 *     } else {
 *       agent.move(obs.self.x + 1, obs.self.y); // walk east
 *     }
 *   });
 * 
 *   agent.connect();
 */

const WebSocket = require('ws');

class AgentWorldSDK {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || 'ws://localhost:3000';
    this.wallet = options.wallet || 'demo-wallet-' + Math.random().toString(36).slice(2, 8);
    this.name = options.name || 'Agent';
    this.metadata = options.metadata || {};

    // Optional signing function for real wallet auth
    // Should be: async (message: string) => string (base58 signature)
    // If not provided, sends 'demo-sig' (works when server has REQUIRE_WALLET_AUTH=false)
    this.signMessage = options.signMessage || null;

    this.ws = null;
    this.agentId = null;
    this.connected = false;
    this.listeners = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 3000;

    // Latest observation cache
    this.lastObservation = null;
  }

  // ==================== CONNECTION ====================

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.serverUrl);

        this.ws.on('open', () => {
          console.log(`[SDK] Connected to ${this.serverUrl}`);
          this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            this._handleMessage(msg, resolve);
          } catch (err) {
            console.error('[SDK] Failed to parse message:', err.message);
          }
        });

        this.ws.on('close', () => {
          this.connected = false;
          console.log('[SDK] Disconnected');
          this._emit('disconnected');
          this._tryReconnect();
        });

        this.ws.on('error', (err) => {
          console.error('[SDK] WebSocket error:', err.message);
          if (!this.connected) reject(err);
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  disconnect() {
    this.maxReconnectAttempts = 0; // prevent reconnection
    if (this.ws) {
      this.ws.close();
    }
  }

  _tryReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[SDK] Max reconnect attempts reached');
      this._emit('reconnect_failed');
      return;
    }

    this.reconnectAttempts++;
    console.log(`[SDK] Reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(() => {
      this.connect().catch(() => {});
    }, this.reconnectDelay);
  }

  _handleMessage(msg, resolveConnect) {
    switch (msg.type) {
      case 'challenge':
        // Sign the challenge and respond with auth
        this._handleChallenge(msg.challenge);
        break;

      case 'welcome':
        this.connected = true;
        this.agentId = msg.agentId;
        this.lastObservation = msg.observation;
        console.log(`[SDK] Authenticated as ${msg.agent.name} (${msg.agentId})`);
        console.log(`[SDK] Position: (${msg.agent.x}, ${msg.agent.y})`);
        this._emit('connected', msg);
        if (resolveConnect) resolveConnect(msg);
        break;

      case 'observation':
        this.lastObservation = msg.observation;
        this._emit('observation', msg.observation);
        if (msg.results && msg.results.length > 0) {
          for (const result of msg.results) {
            this._emit('action_result', result);
          }
        }
        break;

      case 'action_queued':
        this._emit('action_queued', msg);
        break;

      case 'error':
        console.error(`[SDK] Server error: ${msg.message}`);
        this._emit('error', msg);
        break;

      case 'pong':
        this._emit('pong', msg);
        break;

      default:
        this._emit('message', msg);
    }
  }

  // ==================== ACTIONS ====================

  move(x, y) {
    return this._sendAction({ type: 'move', x, y });
  }

  speak(message, radius) {
    return this._sendAction({ type: 'speak', message, radius });
  }

  whisper(targetAgentId, message) {
    return this._sendAction({ type: 'whisper', targetAgentId, message });
  }

  trade(targetAgentId, offer, request) {
    return this._sendAction({ type: 'trade', targetAgentId, offer, request });
  }

  acceptTrade(tradeId) {
    return this._sendAction({ type: 'accept_trade', tradeId });
  }

  rejectTrade(tradeId) {
    return this._sendAction({ type: 'reject_trade', tradeId });
  }

  build(buildingType, x, y) {
    return this._sendAction({ type: 'build', buildingType, x, y });
  }

  claim(x, y) {
    return this._sendAction({ type: 'claim', x, y });
  }

  upgrade(buildingId) {
    return this._sendAction({ type: 'upgrade', buildingId });
  }

  sellLand(x, y, price, buyerAgentId) {
    return this._sendAction({ type: 'sell_land', x, y, price, buyerAgentId });
  }

  deposit(amountSOL) {
    return this._sendAction({ type: 'deposit', amountSOL });
  }

  getBalance() {
    return this._sendAction({ type: 'balance' });
  }

  enter(buildingId) {
    return this._sendAction({ type: 'enter', buildingId });
  }

  inspect(targetAgentId) {
    return this._sendAction({ type: 'inspect', targetAgentId });
  }

  bridge(bridgeName, bridgeAction, params) {
    return this._sendAction({ type: 'bridge', bridge: bridgeName, bridgeAction, params });
  }

  // --- NFT convenience methods ---
  mintNFT(name, description, attributes, imageUrl) {
    return this.bridge('nft', 'mint', { name, description, attributes, imageUrl });
  }

  mintFromTemplate(template, name, attributes) {
    return this.bridge('nft', 'mintFromTemplate', { template, name, attributes });
  }

  listNFT(mint, priceLamports) {
    return this.bridge('nft', 'list', { mint, price: priceLamports });
  }

  buyNFT(mint) {
    return this.bridge('nft', 'buy', { mint });
  }

  transferNFT(mint, toWallet) {
    return this.bridge('nft', 'transfer', { mint, to: toWallet });
  }

  burnNFT(mint) {
    return this.bridge('nft', 'burn', { mint });
  }

  getMyNFTs() {
    return this.bridge('nft', 'getAssetsByOwner', {});
  }

  // --- Polymarket convenience methods ---
  searchMarkets(query) {
    return this.bridge('polymarket', 'search', { query });
  }

  trendingMarkets() {
    return this.bridge('polymarket', 'trending', {});
  }

  getMarket(marketId) {
    return this.bridge('polymarket', 'getMarket', { marketId });
  }

  buyOutcome(marketId, outcome, amount) {
    return this.bridge('polymarket', 'buy', { marketId, outcome, amount });
  }

  sellOutcome(marketId, outcome, shares) {
    return this.bridge('polymarket', 'sell', { marketId, outcome, shares });
  }

  getPredictionPortfolio() {
    return this.bridge('polymarket', 'getPortfolio', {});
  }

  // --- Social convenience methods ---
  tweet(text) {
    return this.bridge('social', 'postTweet', { text });
  }

  sendTelegram(text, chatId) {
    return this.bridge('social', 'sendTelegram', { text, chatId });
  }

  sendDiscord(text) {
    return this.bridge('social', 'sendDiscord', { text });
  }

  broadcastSocial(text) {
    return this.bridge('social', 'postAll', { text });
  }

  // --- Data convenience methods ---
  getTokenPrice(token) {
    return this.bridge('data', 'getPrice', { token });
  }

  getTokenPrices(tokens) {
    return this.bridge('data', 'getPrices', { tokens });
  }

  getTokenInfo(token) {
    return this.bridge('data', 'getTokenInfo', { token });
  }

  getTrendingTokens() {
    return this.bridge('data', 'getTrending', {});
  }

  searchDex(query) {
    return this.bridge('data', 'searchDex', { query });
  }

  getNewPairs() {
    return this.bridge('data', 'getNewPairs', { chain: 'solana' });
  }

  // --- Bounty convenience methods ---
  postBounty(title, description, rewardSOL, options = {}) {
    return this._sendAction({
      type: 'post_bounty', title, description, rewardSOL,
      deadline: options.deadline, tags: options.tags, minReputation: options.minReputation,
    });
  }

  claimBounty(bountyId, timeout) {
    return this._sendAction({ type: 'claim_bounty', bountyId, timeout });
  }

  submitBounty(bountyId, proof, notes) {
    return this._sendAction({ type: 'submit_bounty', bountyId, proof, notes });
  }

  acceptSubmission(bountyId) {
    return this._sendAction({ type: 'accept_submission', bountyId });
  }

  rejectSubmission(bountyId, reason) {
    return this._sendAction({ type: 'reject_submission', bountyId, reason });
  }

  cancelBounty(bountyId) {
    return this._sendAction({ type: 'cancel_bounty', bountyId });
  }

  listBounties(status, tag) {
    return this._sendAction({ type: 'list_bounties', status, tag });
  }

  // --- Reputation rating methods ---
  rateAgent(targetAgentId, score, comment) {
    return this._sendAction({ type: 'rate_agent', targetAgentId, score, comment });
  }

  getRatings(targetAgentId) {
    return this._sendAction({ type: 'get_ratings', targetAgentId });
  }

  // --- Resource methods ---
  gather(x, y) {
    return this._sendAction({ type: 'gather', x, y });
  }

  scanResources(radius) {
    return this._sendAction({ type: 'scan_resources', radius });
  }

  // --- Guild methods ---
  createGuild(name, description, tag) {
    return this._sendAction({ type: 'create_guild', name, description, tag });
  }

  joinGuild(guildId) {
    return this._sendAction({ type: 'join_guild', guildId });
  }

  leaveGuild() {
    return this._sendAction({ type: 'leave_guild' });
  }

  guildInvite(targetAgentId) {
    return this._sendAction({ type: 'guild_invite', targetAgentId });
  }

  guildKick(targetAgentId) {
    return this._sendAction({ type: 'guild_kick', targetAgentId });
  }

  guildDeposit(amountSOL) {
    return this._sendAction({ type: 'guild_deposit', amountSOL });
  }

  guildInfo(guildId) {
    return this._sendAction({ type: 'guild_info', guildId });
  }

  // ==================== HELPERS ====================

  async _handleChallenge(challenge) {
    let signature = 'demo-sig';

    if (this.signMessage) {
      try {
        signature = await this.signMessage(challenge);
        console.log(`[SDK] Challenge signed with wallet`);
      } catch (err) {
        console.error(`[SDK] Signing failed: ${err.message}, using demo signature`);
      }
    }

    this._send({
      type: 'auth',
      wallet: this.wallet,
      signature,
      name: this.name,
      metadata: this.metadata,
    });
  }

  _sendAction(action) {
    return this._send({ type: 'action', action });
  }

  _send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[SDK] Not connected');
      return false;
    }
    this.ws.send(JSON.stringify(data));
    return true;
  }

  ping() {
    return this._send({ type: 'ping' });
  }

  // ==================== EVENT SYSTEM ====================

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return this; // chainable
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
    return this;
  }

  _emit(event, data) {
    if (this.listeners.has(event)) {
      for (const callback of this.listeners.get(event)) {
        try {
          callback(data);
        } catch (err) {
          console.error(`[SDK] Listener error on '${event}':`, err.message);
        }
      }
    }
  }

  // ==================== CONVENIENCE ====================

  get position() {
    return this.lastObservation?.self ? { x: this.lastObservation.self.x, y: this.lastObservation.self.y } : null;
  }

  get nearbyAgents() {
    return this.lastObservation?.nearbyAgents || [];
  }

  get nearbyBuildings() {
    return this.lastObservation?.nearbyBuildings || [];
  }

  get zone() {
    return this.lastObservation?.zone || null;
  }
}

module.exports = { AgentWorldSDK };
