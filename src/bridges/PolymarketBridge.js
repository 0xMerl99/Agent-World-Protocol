/**
 * PolymarketBridge — Prediction market trading via Polymarket.
 * 
 * Actions:
 * - getMarkets: Browse active prediction markets
 * - getMarket: Get details on a specific market (question, outcomes, prices, volume)
 * - getPosition: Check agent's positions on a market
 * - buy: Buy outcome shares (YES/NO)
 * - sell: Sell outcome shares
 * - getPortfolio: Get all open positions for a wallet
 * - trending: Get trending/popular markets
 * - search: Search markets by keyword
 * 
 * Polymarket uses a CLOB (Central Limit Order Book) on Polygon.
 * For Solana agents, the bridge handles the cross-chain abstraction.
 * Protocol fee: 0.5% on trades
 */

const https = require('https');

const TRADE_FEE_BPS = 50; // 0.5%

class PolymarketBridge {
  constructor(options = {}) {
    this.apiBase = 'https://clob.polymarket.com';
    this.gammaApiBase = 'https://gamma-api.polymarket.com';
    this.feeWallet = options.feeWallet || null;
    this.dryRun = options.dryRun !== undefined ? options.dryRun : true;

    // In-memory position tracking for dry-run
    this.positions = new Map(); // agentId -> [{ marketId, outcome, shares, avgPrice }]
    this.tradeCounter = 0;

    console.log(`[PolymarketBridge] Initialized (dryRun: ${this.dryRun})`);
  }

  async execute(action, params) {
    switch (action) {
      case 'getMarkets':
        return this._getMarkets(params);
      case 'getMarket':
        return this._getMarket(params);
      case 'search':
        return this._search(params);
      case 'trending':
        return this._trending(params);
      case 'buy':
        return this._buy(params);
      case 'sell':
        return this._sell(params);
      case 'getPosition':
        return this._getPosition(params);
      case 'getPortfolio':
        return this._getPortfolio(params);
      default:
        return { success: false, error: `Unknown Polymarket action: ${action}` };
    }
  }

  // --- GET MARKETS ---
  async _getMarkets(params) {
    const { limit, offset, active } = params || {};
    const count = Math.min(limit || 20, 100);

    try {
      const url = `${this.gammaApiBase}/markets?limit=${count}&offset=${offset || 0}&active=${active !== false}`;
      const data = await this._httpGet(url);

      if (!Array.isArray(data)) {
        return { success: false, error: 'Unexpected response from Polymarket API' };
      }

      return {
        success: true,
        data: {
          markets: data.map(m => this._formatMarket(m)),
          count: data.length,
        },
      };
    } catch (err) {
      return { success: false, error: `Failed to fetch markets: ${err.message}` };
    }
  }

  // --- GET SINGLE MARKET ---
  async _getMarket(params) {
    const { marketId, conditionId, slug } = params;
    const id = marketId || conditionId || slug;

    if (!id) {
      return { success: false, error: 'Missing marketId, conditionId, or slug' };
    }

    try {
      const url = `${this.gammaApiBase}/markets/${id}`;
      const data = await this._httpGet(url);

      if (!data || data.error) {
        return { success: false, error: data?.error || 'Market not found' };
      }

      return {
        success: true,
        data: this._formatMarket(data),
      };
    } catch (err) {
      return { success: false, error: `Failed to fetch market: ${err.message}` };
    }
  }

  // --- SEARCH MARKETS ---
  async _search(params) {
    const { query, limit } = params;
    if (!query) return { success: false, error: 'Missing search query' };

    try {
      const url = `${this.gammaApiBase}/markets?tag=${encodeURIComponent(query)}&limit=${limit || 20}&active=true`;
      const data = await this._httpGet(url);

      if (!Array.isArray(data)) {
        // Try text search fallback
        const url2 = `${this.gammaApiBase}/markets?limit=100&active=true`;
        const allData = await this._httpGet(url2);
        const filtered = (Array.isArray(allData) ? allData : [])
          .filter(m => (m.question || '').toLowerCase().includes(query.toLowerCase()))
          .slice(0, limit || 20);

        return {
          success: true,
          data: { markets: filtered.map(m => this._formatMarket(m)), count: filtered.length, query },
        };
      }

      return {
        success: true,
        data: { markets: data.map(m => this._formatMarket(m)), count: data.length, query },
      };
    } catch (err) {
      return { success: false, error: `Search failed: ${err.message}` };
    }
  }

  // --- TRENDING ---
  async _trending(params) {
    const { limit } = params || {};

    try {
      const url = `${this.gammaApiBase}/markets?limit=${limit || 10}&active=true&order=volume24hr&ascending=false`;
      const data = await this._httpGet(url);

      return {
        success: true,
        data: {
          markets: (Array.isArray(data) ? data : []).map(m => this._formatMarket(m)),
          count: Array.isArray(data) ? data.length : 0,
        },
      };
    } catch (err) {
      return { success: false, error: `Failed to fetch trending: ${err.message}` };
    }
  }

  // --- BUY ---
  async _buy(params) {
    const { marketId, outcome, amount, agentWallet, agentId } = params;

    if (!marketId) return { success: false, error: 'Missing marketId' };
    if (!outcome || !['YES', 'NO'].includes(outcome.toUpperCase())) {
      return { success: false, error: 'Missing or invalid outcome (must be YES or NO)' };
    }
    if (!amount || amount <= 0) return { success: false, error: 'Missing or invalid amount (in USDC cents)' };
    if (!agentWallet) return { success: false, error: 'Missing agentWallet' };

    const fee = Math.floor(amount * TRADE_FEE_BPS / 10000);
    const normalizedOutcome = outcome.toUpperCase();

    if (this.dryRun) {
      this.tradeCounter++;
      const aid = agentId || agentWallet;

      // Track position
      if (!this.positions.has(aid)) this.positions.set(aid, []);
      const positions = this.positions.get(aid);

      // Simulated price (random between 0.1 and 0.9)
      const price = 0.1 + Math.random() * 0.8;
      const shares = amount / price;

      let existing = positions.find(p => p.marketId === marketId && p.outcome === normalizedOutcome);
      if (existing) {
        const totalCost = existing.avgPrice * existing.shares + price * shares;
        existing.shares += shares;
        existing.avgPrice = totalCost / existing.shares;
      } else {
        positions.push({ marketId, outcome: normalizedOutcome, shares, avgPrice: price, boughtAt: Date.now() });
      }

      return {
        success: true,
        data: {
          type: 'prediction_buy',
          status: 'simulated (dry run)',
          marketId,
          outcome: normalizedOutcome,
          amount,
          shares: Math.round(shares * 100) / 100,
          price: Math.round(price * 1000) / 1000,
          fee,
          tradeId: `dry-run-poly-${this.tradeCounter}`,
        },
        fee,
      };
    }

    // Production: use Polymarket CLOB API to place order
    return {
      success: true,
      data: {
        type: 'prediction_buy',
        status: 'pending_signature',
        marketId,
        outcome: normalizedOutcome,
        amount,
        note: 'Requires Polymarket CLOB API key and Polygon wallet.',
      },
      fee,
    };
  }

  // --- SELL ---
  async _sell(params) {
    const { marketId, outcome, shares, agentWallet, agentId } = params;

    if (!marketId) return { success: false, error: 'Missing marketId' };
    if (!outcome) return { success: false, error: 'Missing outcome' };
    if (!shares || shares <= 0) return { success: false, error: 'Missing or invalid shares' };

    const normalizedOutcome = outcome.toUpperCase();
    const fee = Math.floor(shares * 0.5 * TRADE_FEE_BPS / 10000); // estimate

    if (this.dryRun) {
      this.tradeCounter++;
      const aid = agentId || agentWallet;

      if (!this.positions.has(aid)) {
        return { success: false, error: 'No positions found' };
      }

      const positions = this.positions.get(aid);
      const pos = positions.find(p => p.marketId === marketId && p.outcome === normalizedOutcome);
      if (!pos) return { success: false, error: 'No position in this outcome' };
      if (pos.shares < shares) return { success: false, error: `Insufficient shares: have ${pos.shares}, selling ${shares}` };

      const sellPrice = 0.1 + Math.random() * 0.8;
      const proceeds = shares * sellPrice;

      pos.shares -= shares;
      if (pos.shares <= 0) {
        const idx = positions.indexOf(pos);
        positions.splice(idx, 1);
      }

      return {
        success: true,
        data: {
          type: 'prediction_sell',
          status: 'simulated (dry run)',
          marketId,
          outcome: normalizedOutcome,
          shares,
          sellPrice: Math.round(sellPrice * 1000) / 1000,
          proceeds: Math.round(proceeds * 100) / 100,
          fee,
          tradeId: `dry-run-poly-sell-${this.tradeCounter}`,
        },
        fee,
      };
    }

    return {
      success: true,
      data: { type: 'prediction_sell', status: 'pending_signature', marketId, outcome: normalizedOutcome, shares },
      fee,
    };
  }

  // --- GET POSITION ---
  async _getPosition(params) {
    const { marketId, agentWallet, agentId } = params;
    const aid = agentId || agentWallet;
    if (!marketId || !aid) return { success: false, error: 'Missing marketId or agentWallet' };

    const positions = this.positions.get(aid) || [];
    const marketPositions = positions.filter(p => p.marketId === marketId);

    return {
      success: true,
      data: {
        marketId,
        positions: marketPositions.map(p => ({
          outcome: p.outcome,
          shares: Math.round(p.shares * 100) / 100,
          avgPrice: Math.round(p.avgPrice * 1000) / 1000,
          boughtAt: p.boughtAt,
        })),
      },
    };
  }

  // --- GET PORTFOLIO ---
  async _getPortfolio(params) {
    const { agentWallet, agentId } = params;
    const aid = agentId || agentWallet;
    if (!aid) return { success: false, error: 'Missing agentWallet' };

    const positions = this.positions.get(aid) || [];

    return {
      success: true,
      data: {
        wallet: agentWallet,
        positions: positions.map(p => ({
          marketId: p.marketId,
          outcome: p.outcome,
          shares: Math.round(p.shares * 100) / 100,
          avgPrice: Math.round(p.avgPrice * 1000) / 1000,
          estimatedValue: Math.round(p.shares * p.avgPrice * 100) / 100,
        })),
        totalPositions: positions.length,
      },
    };
  }

  // --- HELPERS ---
  _formatMarket(m) {
    return {
      id: m.id || m.condition_id,
      question: m.question,
      description: m.description,
      outcomes: m.outcomes || ['Yes', 'No'],
      outcomePrices: m.outcomePrices || m.outcome_prices,
      volume: m.volume,
      volume24hr: m.volume24hr || m.volume_num_24hr,
      liquidity: m.liquidity,
      endDate: m.end_date_iso || m.endDate,
      active: m.active,
      closed: m.closed,
      slug: m.slug,
      tags: m.tags,
      image: m.image,
    };
  }

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Invalid JSON from ${url}`)); }
        });
      }).on('error', reject);
    });
  }
}

module.exports = { PolymarketBridge };
