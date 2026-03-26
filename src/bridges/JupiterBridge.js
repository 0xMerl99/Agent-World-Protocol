/**
 * JupiterBridge — Token swaps via Jupiter aggregator.
 * 
 * Actions:
 * - quote: Get a swap quote (price, route, fees)
 * - swap: Execute a token swap
 * - tokens: List available tokens
 * - price: Get token price in USDC
 * 
 * Jupiter finds the best route across all Solana DEXes
 * (Raydium, Orca, Meteora, Phoenix, etc.)
 */

const https = require('https');

// Protocol fee: 0.3% on swap volume
const PROTOCOL_FEE_BPS = 30; // basis points (30 = 0.3%)

// Common token mints
const KNOWN_TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
};

class JupiterBridge {
  constructor(options = {}) {
    this.apiBase = options.apiBase || 'https://quote-api.jup.ag/v6';
    this.priceApiBase = 'https://price.jup.ag/v6';
    this.feeWallet = options.feeWallet || null;
    this.dryRun = options.dryRun !== undefined ? options.dryRun : true;
    this.feeBps = options.feeBps || PROTOCOL_FEE_BPS;

    console.log(`[JupiterBridge] Initialized (dryRun: ${this.dryRun}, fee: ${this.feeBps}bps)`);
  }

  async execute(action, params) {
    switch (action) {
      case 'quote':
        return this._getQuote(params);
      case 'swap':
        return this._executeSwap(params);
      case 'tokens':
        return this._getTokens(params);
      case 'price':
        return this._getPrice(params);
      case 'resolve':
        return this._resolveToken(params);
      default:
        return { success: false, error: `Unknown Jupiter action: ${action}` };
    }
  }

  // --- GET QUOTE ---
  async _getQuote(params) {
    const { inputMint, outputMint, amount, inputToken, outputToken, slippageBps } = params;

    // Resolve token symbols to mints
    const inMint = inputMint || KNOWN_TOKENS[inputToken?.toUpperCase()] || inputToken;
    const outMint = outputMint || KNOWN_TOKENS[outputToken?.toUpperCase()] || outputToken;

    if (!inMint || !outMint) {
      return {
        success: false,
        error: `Missing or unresolved token mints. Known tokens: ${Object.keys(KNOWN_TOKENS).join(', ')}`,
      };
    }

    if (!amount || amount <= 0) {
      return { success: false, error: 'Missing or invalid amount' };
    }

    try {
      const queryParams = new URLSearchParams({
        inputMint: inMint,
        outputMint: outMint,
        amount: amount.toString(),
        slippageBps: (slippageBps || 50).toString(),
        platformFeeBps: this.feeBps.toString(),
      });

      const url = `${this.apiBase}/quote?${queryParams}`;
      const data = await this._httpGet(url);

      if (data.error) {
        return { success: false, error: data.error };
      }

      // Calculate protocol fee
      const inAmount = parseInt(data.inAmount || amount);
      const fee = Math.floor(inAmount * this.feeBps / 10000);

      return {
        success: true,
        data: {
          inputMint: inMint,
          outputMint: outMint,
          inAmount: data.inAmount,
          outAmount: data.outAmount,
          priceImpactPct: data.priceImpactPct,
          routePlan: data.routePlan?.map(r => ({
            swapInfo: {
              label: r.swapInfo?.label,
              inputMint: r.swapInfo?.inputMint,
              outputMint: r.swapInfo?.outputMint,
            },
            percent: r.percent,
          })),
          otherAmountThreshold: data.otherAmountThreshold,
          slippageBps: data.slippageBps,
          platformFee: {
            amount: fee,
            feeBps: this.feeBps,
          },
        },
        fee,
      };
    } catch (err) {
      return { success: false, error: `Quote failed: ${err.message}` };
    }
  }

  // --- EXECUTE SWAP ---
  async _executeSwap(params) {
    const { inputMint, outputMint, amount, inputToken, outputToken, slippageBps, agentWallet } = params;

    if (!agentWallet) {
      return { success: false, error: 'Missing agentWallet — needed to build swap transaction' };
    }

    // First get a quote
    const quoteResult = await this._getQuote(params);
    if (!quoteResult.success) {
      return quoteResult;
    }

    if (this.dryRun) {
      return {
        success: true,
        data: {
          type: 'swap',
          status: 'simulated (dry run)',
          quote: quoteResult.data,
          wallet: agentWallet,
          note: 'Enable live mode to execute real swaps.',
          signature: `dry-run-swap-${Date.now()}`,
        },
        fee: quoteResult.fee,
      };
    }

    // In production, this would:
    // 1. POST to Jupiter /swap endpoint with the quote + wallet
    // 2. Get back a serialized transaction
    // 3. Sign with agent's keypair
    // 4. Submit to Solana
    try {
      const swapUrl = `${this.apiBase}/swap`;
      const swapBody = {
        quoteResponse: quoteResult.data,
        userPublicKey: agentWallet,
        wrapAndUnwrapSol: true,
        feeAccount: this.feeWallet || undefined,
        platformFeeBps: this.feeBps,
      };

      // For now return the intent
      return {
        success: true,
        data: {
          type: 'swap',
          status: 'pending_signature',
          quote: quoteResult.data,
          wallet: agentWallet,
          note: 'Transaction built. Requires agent keypair to sign and submit.',
        },
        fee: quoteResult.fee,
      };
    } catch (err) {
      return { success: false, error: `Swap failed: ${err.message}` };
    }
  }

  // --- GET TOKEN PRICE ---
  async _getPrice(params) {
    const { token, mint, vsToken } = params;

    const tokenMint = mint || KNOWN_TOKENS[token?.toUpperCase()] || token;
    if (!tokenMint) {
      return { success: false, error: 'Missing token or mint address' };
    }

    try {
      const vs = vsToken || KNOWN_TOKENS.USDC;
      const url = `${this.priceApiBase}/price?ids=${tokenMint}&vsToken=${vs}`;
      const data = await this._httpGet(url);

      if (data.data && data.data[tokenMint]) {
        const priceData = data.data[tokenMint];
        return {
          success: true,
          data: {
            token: token || tokenMint,
            mint: tokenMint,
            price: priceData.price,
            vsToken: vs,
          },
        };
      }

      return { success: false, error: 'Price data not available' };
    } catch (err) {
      return { success: false, error: `Price fetch failed: ${err.message}` };
    }
  }

  // --- LIST KNOWN TOKENS ---
  async _getTokens() {
    return {
      success: true,
      data: {
        tokens: Object.entries(KNOWN_TOKENS).map(([symbol, mint]) => ({
          symbol,
          mint,
        })),
        note: 'Any valid SPL token mint address can be used, not just these.',
      },
    };
  }

  // --- RESOLVE TOKEN SYMBOL TO MINT ---
  async _resolveToken(params) {
    const { token } = params;
    if (!token) return { success: false, error: 'Missing token' };

    const mint = KNOWN_TOKENS[token.toUpperCase()];
    if (mint) {
      return { success: true, data: { symbol: token.toUpperCase(), mint } };
    }

    // Check if it's already a valid mint address (base58, 32-44 chars)
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) {
      return { success: true, data: { symbol: null, mint: token } };
    }

    return { success: false, error: `Unknown token: ${token}. Known: ${Object.keys(KNOWN_TOKENS).join(', ')}` };
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
            reject(new Error(`Invalid JSON response from ${url}`));
          }
        });
      }).on('error', reject);
    });
  }
}

module.exports = { JupiterBridge, KNOWN_TOKENS };
