/**
 * SolanaBridge — Direct interaction with the Solana blockchain.
 * 
 * Actions:
 * - getBalance: Check SOL balance for a wallet
 * - getTokenBalance: Check SPL token balance
 * - transfer: Send SOL to another wallet
 * - transferToken: Send SPL tokens
 * - getTransaction: Look up a transaction
 * - getRecentBlockhash: Get current blockhash
 * 
 * Requires RPC endpoint (Helius, Quicknode, or public).
 */

const { Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } = require('@solana/web3.js');

// Protocol fee: 0.1% on transfers
const PROTOCOL_FEE_BPS = 10; // basis points (10 = 0.1%)

class SolanaBridge {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    this.feeWallet = options.feeWallet || null;
    this.network = options.network || 'mainnet-beta';
    this.dryRun = options.dryRun !== undefined ? options.dryRun : true; // safety: dry run by default

    console.log(`[SolanaBridge] Initialized (${this.network}, dryRun: ${this.dryRun})`);
  }

  async execute(action, params) {
    switch (action) {
      case 'getBalance':
        return this._getBalance(params);
      case 'getTokenBalance':
        return this._getTokenBalance(params);
      case 'transfer':
        return this._transfer(params);
      case 'getTransaction':
        return this._getTransaction(params);
      case 'getSlot':
        return this._getSlot();
      case 'getRecentBlockhash':
        return this._getRecentBlockhash();
      default:
        return { success: false, error: `Unknown Solana action: ${action}` };
    }
  }

  // --- GET BALANCE ---
  async _getBalance(params) {
    const { wallet, agentWallet } = params;
    const address = wallet || agentWallet;

    if (!address) {
      return { success: false, error: 'Missing wallet address' };
    }

    try {
      const pubkey = new PublicKey(address);
      const balance = await this.connection.getBalance(pubkey);

      return {
        success: true,
        data: {
          wallet: address,
          balanceLamports: balance,
          balanceSOL: balance / LAMPORTS_PER_SOL,
        },
      };
    } catch (err) {
      return { success: false, error: `Failed to get balance: ${err.message}` };
    }
  }

  // --- GET TOKEN BALANCE ---
  async _getTokenBalance(params) {
    const { wallet, agentWallet, mint } = params;
    const address = wallet || agentWallet;

    if (!address || !mint) {
      return { success: false, error: 'Missing wallet or mint address' };
    }

    try {
      const pubkey = new PublicKey(address);
      const mintPubkey = new PublicKey(mint);

      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubkey, {
        mint: mintPubkey,
      });

      if (tokenAccounts.value.length === 0) {
        return {
          success: true,
          data: { wallet: address, mint, balance: 0, decimals: 0 },
        };
      }

      const account = tokenAccounts.value[0].account.data.parsed.info;
      return {
        success: true,
        data: {
          wallet: address,
          mint,
          balance: parseFloat(account.tokenAmount.uiAmountString),
          decimals: account.tokenAmount.decimals,
          rawBalance: account.tokenAmount.amount,
        },
      };
    } catch (err) {
      return { success: false, error: `Failed to get token balance: ${err.message}` };
    }
  }

  // --- TRANSFER SOL ---
  async _transfer(params) {
    const { agentWallet, to, amountSOL, amountLamports } = params;

    if (!agentWallet || !to) {
      return { success: false, error: 'Missing agentWallet or destination address' };
    }

    const amount = amountLamports || (amountSOL ? Math.floor(amountSOL * LAMPORTS_PER_SOL) : 0);
    if (amount <= 0) {
      return { success: false, error: 'Invalid transfer amount' };
    }

    // Calculate protocol fee
    const fee = Math.floor(amount * PROTOCOL_FEE_BPS / 10000);
    const netAmount = amount - fee;

    if (this.dryRun) {
      // Simulate the transaction
      return {
        success: true,
        data: {
          type: 'transfer',
          from: agentWallet,
          to,
          amountLamports: netAmount,
          amountSOL: netAmount / LAMPORTS_PER_SOL,
          feeLamports: fee,
          feeSOL: fee / LAMPORTS_PER_SOL,
          status: 'simulated (dry run)',
          signature: `dry-run-${Date.now()}`,
        },
        fee,
      };
    }

    // Real transaction would go here
    // In production: sign with agent's keypair, send transaction
    // For now, return simulation
    try {
      return {
        success: true,
        data: {
          type: 'transfer',
          from: agentWallet,
          to,
          amountLamports: netAmount,
          amountSOL: netAmount / LAMPORTS_PER_SOL,
          feeLamports: fee,
          feeSOL: fee / LAMPORTS_PER_SOL,
          status: 'pending_signature',
          note: 'Transaction requires agent keypair signature. Connect wallet to execute.',
        },
        fee,
      };
    } catch (err) {
      return { success: false, error: `Transfer failed: ${err.message}` };
    }
  }

  // --- GET TRANSACTION ---
  async _getTransaction(params) {
    const { signature } = params;
    if (!signature) {
      return { success: false, error: 'Missing transaction signature' };
    }

    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        return { success: false, error: 'Transaction not found' };
      }

      return {
        success: true,
        data: {
          signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          fee: tx.meta?.fee,
          success: tx.meta?.err === null,
          err: tx.meta?.err,
        },
      };
    } catch (err) {
      return { success: false, error: `Failed to get transaction: ${err.message}` };
    }
  }

  // --- GET SLOT ---
  async _getSlot() {
    try {
      const slot = await this.connection.getSlot();
      return { success: true, data: { slot } };
    } catch (err) {
      return { success: false, error: `Failed to get slot: ${err.message}` };
    }
  }

  // --- GET RECENT BLOCKHASH ---
  async _getRecentBlockhash() {
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      return {
        success: true,
        data: { blockhash, lastValidBlockHeight },
      };
    } catch (err) {
      return { success: false, error: `Failed to get blockhash: ${err.message}` };
    }
  }
}

module.exports = { SolanaBridge };
