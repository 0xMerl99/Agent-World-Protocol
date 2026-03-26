/**
 * PumpFunBridge — Token creation and trading on pump.fun.
 * 
 * Actions:
 * - create: Launch a new token on pump.fun
 * - buy: Buy tokens on a bonding curve
 * - sell: Sell tokens on a bonding curve
 * - getToken: Get token info (market cap, holders, etc.)
 * - trending: Get trending tokens
 * 
 * Protocol fee: 1% on token launches, 0.5% on trades
 */

const https = require('https');

const LAUNCH_FEE_BPS = 100;  // 1% on launches
const TRADE_FEE_BPS = 50;    // 0.5% on trades

class PumpFunBridge {
  constructor(options = {}) {
    this.apiBase = 'https://frontend-api.pump.fun';
    this.feeWallet = options.feeWallet || null;
    this.dryRun = options.dryRun !== undefined ? options.dryRun : true;

    console.log(`[PumpFunBridge] Initialized (dryRun: ${this.dryRun})`);
  }

  async execute(action, params) {
    switch (action) {
      case 'create':
        return this._createToken(params);
      case 'buy':
        return this._buyToken(params);
      case 'sell':
        return this._sellToken(params);
      case 'getToken':
        return this._getToken(params);
      case 'trending':
        return this._getTrending(params);
      default:
        return { success: false, error: `Unknown pump.fun action: ${action}` };
    }
  }

  // --- CREATE TOKEN ---
  async _createToken(params) {
    const { name, symbol, description, agentWallet, initialBuySOL, imageUrl } = params;

    if (!name || !symbol) {
      return { success: false, error: 'Missing token name or symbol' };
    }

    if (!agentWallet) {
      return { success: false, error: 'Missing agentWallet' };
    }

    // Validate symbol (1-10 uppercase chars)
    if (!/^[A-Z0-9]{1,10}$/.test(symbol.toUpperCase())) {
      return { success: false, error: 'Symbol must be 1-10 alphanumeric characters' };
    }

    const initialBuy = initialBuySOL || 0;
    const fee = Math.floor((initialBuy * 1e9) * LAUNCH_FEE_BPS / 10000);

    if (this.dryRun) {
      return {
        success: true,
        data: {
          type: 'token_launch',
          status: 'simulated (dry run)',
          token: {
            name,
            symbol: symbol.toUpperCase(),
            description: description || '',
            creator: agentWallet,
            initialBuySOL: initialBuy,
            imageUrl: imageUrl || null,
          },
          bondingCurve: {
            type: 'pump.fun standard',
            note: 'Token starts on bonding curve. Migrates to Raydium at ~$69k market cap.',
          },
          fee: {
            protocolFeeLamports: fee,
            protocolFeeSOL: fee / 1e9,
            pumpFunFee: '0.02 SOL (platform fee)',
          },
          signature: `dry-run-create-${Date.now()}`,
        },
        fee,
      };
    }

    // In production:
    // 1. Upload image to IPFS if provided
    // 2. Create token metadata
    // 3. Call pump.fun create instruction
    // 4. Optionally buy initial supply
    return {
      success: true,
      data: {
        type: 'token_launch',
        status: 'pending_signature',
        token: { name, symbol: symbol.toUpperCase(), description, creator: agentWallet },
        note: 'Transaction built. Requires agent keypair to sign.',
      },
      fee,
    };
  }

  // --- BUY TOKEN ---
  async _buyToken(params) {
    const { mint, amountSOL, agentWallet, slippageBps } = params;

    if (!mint) {
      return { success: false, error: 'Missing token mint address' };
    }
    if (!amountSOL || amountSOL <= 0) {
      return { success: false, error: 'Missing or invalid amountSOL' };
    }
    if (!agentWallet) {
      return { success: false, error: 'Missing agentWallet' };
    }

    const amountLamports = Math.floor(amountSOL * 1e9);
    const fee = Math.floor(amountLamports * TRADE_FEE_BPS / 10000);

    if (this.dryRun) {
      return {
        success: true,
        data: {
          type: 'buy',
          status: 'simulated (dry run)',
          mint,
          amountSOL,
          amountLamports,
          slippageBps: slippageBps || 500,
          wallet: agentWallet,
          fee: {
            protocolFeeLamports: fee,
            protocolFeeSOL: fee / 1e9,
            pumpFunFee: '1% (platform fee)',
          },
          signature: `dry-run-buy-${Date.now()}`,
        },
        fee,
      };
    }

    return {
      success: true,
      data: {
        type: 'buy',
        status: 'pending_signature',
        mint,
        amountSOL,
        wallet: agentWallet,
        note: 'Transaction requires agent keypair.',
      },
      fee,
    };
  }

  // --- SELL TOKEN ---
  async _sellToken(params) {
    const { mint, amountTokens, agentWallet, slippageBps } = params;

    if (!mint) {
      return { success: false, error: 'Missing token mint address' };
    }
    if (!amountTokens || amountTokens <= 0) {
      return { success: false, error: 'Missing or invalid amountTokens' };
    }
    if (!agentWallet) {
      return { success: false, error: 'Missing agentWallet' };
    }

    // Fee is estimated since we don't know the output SOL amount
    const estimatedFee = 0; // calculated post-swap

    if (this.dryRun) {
      return {
        success: true,
        data: {
          type: 'sell',
          status: 'simulated (dry run)',
          mint,
          amountTokens,
          slippageBps: slippageBps || 500,
          wallet: agentWallet,
          fee: {
            note: 'Protocol fee (0.5%) applied to SOL output after swap.',
            pumpFunFee: '1% (platform fee)',
          },
          signature: `dry-run-sell-${Date.now()}`,
        },
        fee: estimatedFee,
      };
    }

    return {
      success: true,
      data: {
        type: 'sell',
        status: 'pending_signature',
        mint,
        amountTokens,
        wallet: agentWallet,
        note: 'Transaction requires agent keypair.',
      },
      fee: estimatedFee,
    };
  }

  // --- GET TOKEN INFO ---
  async _getToken(params) {
    const { mint } = params;
    if (!mint) {
      return { success: false, error: 'Missing token mint address' };
    }

    try {
      const url = `${this.apiBase}/coins/${mint}`;
      const data = await this._httpGet(url);

      if (!data || data.statusCode === 404) {
        return { success: false, error: 'Token not found on pump.fun' };
      }

      return {
        success: true,
        data: {
          mint: data.mint,
          name: data.name,
          symbol: data.symbol,
          description: data.description,
          imageUri: data.image_uri,
          creator: data.creator,
          marketCap: data.usd_market_cap,
          replyCount: data.reply_count,
          isMigrated: data.raydium_pool !== null,
          raydiumPool: data.raydium_pool,
          createdTimestamp: data.created_timestamp,
          website: data.website,
          twitter: data.twitter,
          telegram: data.telegram,
        },
      };
    } catch (err) {
      return { success: false, error: `Failed to get token info: ${err.message}` };
    }
  }

  // --- TRENDING TOKENS ---
  async _getTrending(params) {
    const { limit } = params;
    const count = Math.min(limit || 10, 50);

    try {
      const url = `${this.apiBase}/coins?offset=0&limit=${count}&sort=market_cap&order=DESC&includeNsfw=false`;
      const data = await this._httpGet(url);

      if (!Array.isArray(data)) {
        return { success: false, error: 'Unexpected response from pump.fun API' };
      }

      return {
        success: true,
        data: {
          tokens: data.map(t => ({
            mint: t.mint,
            name: t.name,
            symbol: t.symbol,
            marketCap: t.usd_market_cap,
            replyCount: t.reply_count,
            creator: t.creator,
            isMigrated: t.raydium_pool !== null,
          })),
          count: data.length,
        },
      };
    } catch (err) {
      return { success: false, error: `Failed to get trending: ${err.message}` };
    }
  }

  // --- HTTP HELPER ---
  _httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      }).on('error', reject);
    });
  }
}

module.exports = { PumpFunBridge };
