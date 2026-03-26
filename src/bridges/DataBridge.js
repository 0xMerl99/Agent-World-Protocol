/**
 * DataBridge — Market data, price feeds, and analytics for agents.
 * 
 * Actions:
 * - getPrice: Get token price (CoinGecko)
 * - getPrices: Get multiple token prices at once
 * - getTokenInfo: Detailed token data (market cap, volume, supply)
 * - getTrending: Trending tokens on CoinGecko
 * - getDexPair: Get DEX pair data from DexScreener
 * - searchDex: Search for tokens on DexScreener
 * - getNewPairs: Get recently created trading pairs
 * - getGlobalStats: Crypto market global stats
 * - getGasPrice: Get current Solana priority fee estimates
 * 
 * No protocol fee on data queries — data access drives trading activity.
 */

const https = require('https');

// Common token IDs for CoinGecko
const COINGECKO_IDS = {
  SOL: 'solana',
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDC: 'usd-coin',
  USDT: 'tether',
  BONK: 'bonk',
  WIF: 'dogwifcoin',
  JUP: 'jupiter-exchange-solana',
  RAY: 'raydium',
  RNDR: 'render-token',
  PYTH: 'pyth-network',
  JTO: 'jito-governance-token',
};

class DataBridge {
  constructor(options = {}) {
    this.coingeckoBase = 'https://api.coingecko.com/api/v3';
    this.dexscreenerBase = 'https://api.dexscreener.com/latest';
    this.dryRun = options.dryRun !== undefined ? options.dryRun : true;

    // Cache to avoid rate limiting
    this.cache = new Map();
    this.cacheTTL = 30000; // 30 second cache

    console.log(`[DataBridge] Initialized`);
  }

  async execute(action, params) {
    switch (action) {
      case 'getPrice':
        return this._getPrice(params);
      case 'getPrices':
        return this._getPrices(params);
      case 'getTokenInfo':
        return this._getTokenInfo(params);
      case 'getTrending':
        return this._getTrending(params);
      case 'getDexPair':
        return this._getDexPair(params);
      case 'searchDex':
        return this._searchDex(params);
      case 'getNewPairs':
        return this._getNewPairs(params);
      case 'getGlobalStats':
        return this._getGlobalStats(params);
      case 'tokens':
        return this._getTokenList(params);
      default:
        return { success: false, error: `Unknown data action: ${action}` };
    }
  }

  // --- GET PRICE ---
  async _getPrice(params) {
    const { token, mint, vs } = params;
    if (!token && !mint) return { success: false, error: 'Missing token symbol or mint address' };

    const cgId = token ? COINGECKO_IDS[token.toUpperCase()] : null;
    const vsCurrency = vs || 'usd';

    if (cgId) {
      try {
        const data = await this._cachedGet(`${this.coingeckoBase}/simple/price?ids=${cgId}&vs_currencies=${vsCurrency}&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`);

        if (data && data[cgId]) {
          const price = data[cgId];
          return {
            success: true,
            data: {
              token: token.toUpperCase(),
              coingeckoId: cgId,
              price: price[vsCurrency],
              change24h: price[`${vsCurrency}_24h_change`],
              volume24h: price[`${vsCurrency}_24h_vol`],
              marketCap: price[`${vsCurrency}_market_cap`],
              vs: vsCurrency,
            },
          };
        }
      } catch (err) {
        return { success: false, error: `Price fetch failed: ${err.message}` };
      }
    }

    // Try DexScreener for unknown tokens / mint addresses
    if (mint) {
      return this._getDexPair({ address: mint });
    }

    return { success: false, error: `Unknown token: ${token}. Known: ${Object.keys(COINGECKO_IDS).join(', ')}. Or provide a mint address.` };
  }

  // --- GET MULTIPLE PRICES ---
  async _getPrices(params) {
    const { tokens, vs } = params;
    if (!tokens || !Array.isArray(tokens)) return { success: false, error: 'Missing tokens array' };

    const vsCurrency = vs || 'usd';
    const cgIds = tokens
      .map(t => COINGECKO_IDS[t.toUpperCase()])
      .filter(Boolean);

    if (cgIds.length === 0) {
      return { success: false, error: `No recognized tokens. Known: ${Object.keys(COINGECKO_IDS).join(', ')}` };
    }

    try {
      const data = await this._cachedGet(`${this.coingeckoBase}/simple/price?ids=${cgIds.join(',')}&vs_currencies=${vsCurrency}&include_24hr_change=true`);

      const prices = {};
      tokens.forEach(t => {
        const cgId = COINGECKO_IDS[t.toUpperCase()];
        if (cgId && data[cgId]) {
          prices[t.toUpperCase()] = {
            price: data[cgId][vsCurrency],
            change24h: data[cgId][`${vsCurrency}_24h_change`],
          };
        }
      });

      return { success: true, data: { prices, vs: vsCurrency, count: Object.keys(prices).length } };
    } catch (err) {
      return { success: false, error: `Prices fetch failed: ${err.message}` };
    }
  }

  // --- GET TOKEN INFO ---
  async _getTokenInfo(params) {
    const { token } = params;
    if (!token) return { success: false, error: 'Missing token' };

    const cgId = COINGECKO_IDS[token.toUpperCase()] || token.toLowerCase();

    try {
      const data = await this._cachedGet(`${this.coingeckoBase}/coins/${cgId}?localization=false&tickers=false&community_data=false&developer_data=false`);

      if (!data || data.error) {
        return { success: false, error: data?.error || 'Token not found' };
      }

      return {
        success: true,
        data: {
          id: data.id,
          symbol: data.symbol?.toUpperCase(),
          name: data.name,
          price: data.market_data?.current_price?.usd,
          marketCap: data.market_data?.market_cap?.usd,
          volume24h: data.market_data?.total_volume?.usd,
          change24h: data.market_data?.price_change_percentage_24h,
          change7d: data.market_data?.price_change_percentage_7d,
          change30d: data.market_data?.price_change_percentage_30d,
          ath: data.market_data?.ath?.usd,
          athDate: data.market_data?.ath_date?.usd,
          circulatingSupply: data.market_data?.circulating_supply,
          totalSupply: data.market_data?.total_supply,
          maxSupply: data.market_data?.max_supply,
          rank: data.market_cap_rank,
          description: data.description?.en?.slice(0, 200),
          links: {
            website: data.links?.homepage?.[0],
            twitter: data.links?.twitter_screen_name,
            telegram: data.links?.telegram_channel_identifier,
          },
        },
      };
    } catch (err) {
      return { success: false, error: `Token info failed: ${err.message}` };
    }
  }

  // --- TRENDING ---
  async _getTrending(params) {
    try {
      const data = await this._cachedGet(`${this.coingeckoBase}/search/trending`);

      if (!data || !data.coins) {
        return { success: false, error: 'Trending data unavailable' };
      }

      return {
        success: true,
        data: {
          coins: data.coins.map(c => ({
            id: c.item.id,
            symbol: c.item.symbol,
            name: c.item.name,
            rank: c.item.market_cap_rank,
            priceBtc: c.item.price_btc,
            score: c.item.score,
          })),
        },
      };
    } catch (err) {
      return { success: false, error: `Trending failed: ${err.message}` };
    }
  }

  // --- DEX PAIR (DexScreener) ---
  async _getDexPair(params) {
    const { address, pair } = params;
    const query = address || pair;
    if (!query) return { success: false, error: 'Missing token address or pair address' };

    try {
      const data = await this._cachedGet(`${this.dexscreenerBase}/dex/tokens/${query}`);

      if (!data || !data.pairs || data.pairs.length === 0) {
        return { success: false, error: 'No pairs found for this token' };
      }

      const pairs = data.pairs.slice(0, 5).map(p => ({
        dex: p.dexId,
        pairAddress: p.pairAddress,
        baseToken: { symbol: p.baseToken?.symbol, name: p.baseToken?.name, address: p.baseToken?.address },
        quoteToken: { symbol: p.quoteToken?.symbol, name: p.quoteToken?.name },
        priceUsd: p.priceUsd,
        priceNative: p.priceNative,
        volume24h: p.volume?.h24,
        priceChange5m: p.priceChange?.m5,
        priceChange1h: p.priceChange?.h1,
        priceChange24h: p.priceChange?.h24,
        liquidity: p.liquidity?.usd,
        fdv: p.fdv,
        pairCreatedAt: p.pairCreatedAt,
      }));

      return { success: true, data: { token: query, pairs, count: pairs.length } };
    } catch (err) {
      return { success: false, error: `DexScreener failed: ${err.message}` };
    }
  }

  // --- SEARCH DEX ---
  async _searchDex(params) {
    const { query } = params;
    if (!query) return { success: false, error: 'Missing search query' };

    try {
      const data = await this._cachedGet(`${this.dexscreenerBase}/dex/search/?q=${encodeURIComponent(query)}`);

      if (!data || !data.pairs) {
        return { success: true, data: { query, results: [], count: 0 } };
      }

      const results = data.pairs.slice(0, 10).map(p => ({
        baseToken: p.baseToken?.symbol,
        quoteToken: p.quoteToken?.symbol,
        dex: p.dexId,
        chain: p.chainId,
        priceUsd: p.priceUsd,
        volume24h: p.volume?.h24,
        liquidity: p.liquidity?.usd,
        pairAddress: p.pairAddress,
      }));

      return { success: true, data: { query, results, count: results.length } };
    } catch (err) {
      return { success: false, error: `DexScreener search failed: ${err.message}` };
    }
  }

  // --- NEW PAIRS ---
  async _getNewPairs(params) {
    const { chain } = params || {};

    try {
      const chainFilter = chain || 'solana';
      const data = await this._cachedGet(`${this.dexscreenerBase}/dex/pairs/${chainFilter}`);

      if (!data || !data.pairs) {
        return { success: true, data: { chain: chainFilter, pairs: [], count: 0 } };
      }

      const pairs = data.pairs.slice(0, 20).map(p => ({
        baseToken: p.baseToken?.symbol,
        quoteToken: p.quoteToken?.symbol,
        dex: p.dexId,
        priceUsd: p.priceUsd,
        volume24h: p.volume?.h24,
        liquidity: p.liquidity?.usd,
        pairAddress: p.pairAddress,
        createdAt: p.pairCreatedAt,
      }));

      return { success: true, data: { chain: chainFilter, pairs, count: pairs.length } };
    } catch (err) {
      return { success: false, error: `New pairs failed: ${err.message}` };
    }
  }

  // --- GLOBAL STATS ---
  async _getGlobalStats() {
    try {
      const data = await this._cachedGet(`${this.coingeckoBase}/global`);

      if (!data || !data.data) {
        return { success: false, error: 'Global stats unavailable' };
      }

      const g = data.data;
      return {
        success: true,
        data: {
          totalMarketCap: g.total_market_cap?.usd,
          totalVolume24h: g.total_volume?.usd,
          btcDominance: g.market_cap_percentage?.btc,
          ethDominance: g.market_cap_percentage?.eth,
          activeCryptocurrencies: g.active_cryptocurrencies,
          markets: g.markets,
          marketCapChange24h: g.market_cap_change_percentage_24h_usd,
        },
      };
    } catch (err) {
      return { success: false, error: `Global stats failed: ${err.message}` };
    }
  }

  // --- TOKEN LIST ---
  _getTokenList() {
    return {
      success: true,
      data: {
        tokens: Object.entries(COINGECKO_IDS).map(([symbol, id]) => ({ symbol, coingeckoId: id })),
        note: 'Use getPrice with any token symbol above, or provide a Solana mint address for DexScreener lookup.',
      },
    };
  }

  // --- CACHE ---
  async _cachedGet(url) {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.time < this.cacheTTL) {
      return cached.data;
    }

    const data = await this._httpGet(url);
    this.cache.set(url, { data, time: Date.now() });

    // Prune old cache entries
    if (this.cache.size > 100) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].time - b[1].time);
      for (let i = 0; i < 50; i++) this.cache.delete(oldest[i][0]);
    }

    return data;
  }

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'AgentWorldProtocol/1.0' } }, (res) => {
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

module.exports = { DataBridge, COINGECKO_IDS };
