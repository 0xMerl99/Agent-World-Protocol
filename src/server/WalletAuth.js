/**
 * WalletAuth — Solana wallet signature verification.
 * 
 * How it works:
 * 1. Server sends a random challenge string to the connecting agent
 * 2. Agent signs the challenge with their Solana private key
 * 3. Server verifies the signature using the agent's public key (wallet address)
 * 4. If valid, the agent is authenticated as the owner of that wallet
 * 
 * This proves the connecting agent actually controls the wallet they claim to own.
 * Without this, anyone could connect as any wallet address.
 * 
 * Falls back to demo mode (accept any signature) when REQUIRE_WALLET_AUTH=false.
 */

const { PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const crypto = require('crypto');

class WalletAuth {
  constructor(options = {}) {
    this.requireAuth = options.requireAuth !== undefined ? options.requireAuth : (process.env.REQUIRE_WALLET_AUTH === 'true');
    this.challengeExpiry = options.challengeExpiry || 60000; // 60 seconds to sign
    this.pendingChallenges = new Map(); // clientId -> { challenge, createdAt, wallet }

    if (this.requireAuth) {
      console.log('[Auth] Wallet signature verification ENABLED');
    } else {
      console.log('[Auth] Wallet verification DISABLED (demo mode — set REQUIRE_WALLET_AUTH=true for production)');
    }
  }

  /**
   * Generate a challenge for a connecting client.
   * Returns a unique string that the client must sign.
   */
  generateChallenge(clientId) {
    const challenge = `AWP-AUTH-${crypto.randomBytes(32).toString('hex')}-${Date.now()}`;

    this.pendingChallenges.set(clientId, {
      challenge,
      createdAt: Date.now(),
    });

    // Clean up expired challenges periodically
    this._cleanupExpired();

    return challenge;
  }

  /**
   * Verify a wallet signature against a pending challenge.
   * 
   * @param {string} clientId - WebSocket client ID
   * @param {string} wallet - Solana wallet public key (base58)
   * @param {string} signature - Base58-encoded signature of the challenge
   * @returns {{ valid: boolean, error?: string }}
   */
  verify(clientId, wallet, signature) {
    // Demo mode — accept anything
    if (!this.requireAuth) {
      return { valid: true, mode: 'demo' };
    }

    // Check pending challenge exists
    const pending = this.pendingChallenges.get(clientId);
    if (!pending) {
      return { valid: false, error: 'No pending challenge for this connection. Reconnect.' };
    }

    // Check expiry
    if (Date.now() - pending.createdAt > this.challengeExpiry) {
      this.pendingChallenges.delete(clientId);
      return { valid: false, error: 'Challenge expired. Reconnect.' };
    }

    // Validate wallet address format
    let publicKey;
    try {
      publicKey = new PublicKey(wallet);
      if (!PublicKey.isOnCurve(publicKey)) {
        return { valid: false, error: 'Invalid wallet address (not on ed25519 curve)' };
      }
    } catch (err) {
      return { valid: false, error: `Invalid wallet address: ${err.message}` };
    }

    // Verify signature
    try {
      const messageBytes = new TextEncoder().encode(pending.challenge);
      let signatureBytes;

      // Handle both base58 and raw buffer signatures
      if (typeof signature === 'string') {
        signatureBytes = bs58.decode(signature);
      } else if (signature instanceof Uint8Array || Buffer.isBuffer(signature)) {
        signatureBytes = signature;
      } else {
        return { valid: false, error: 'Invalid signature format (expected base58 string or Uint8Array)' };
      }

      // ed25519 signature should be 64 bytes
      if (signatureBytes.length !== 64) {
        return { valid: false, error: `Invalid signature length: ${signatureBytes.length} (expected 64)` };
      }

      // Use tweetnacl-compatible verification via @solana/web3.js
      const verified = verifyEd25519(messageBytes, signatureBytes, publicKey.toBytes());

      if (verified) {
        this.pendingChallenges.delete(clientId);
        return { valid: true, mode: 'verified' };
      } else {
        return { valid: false, error: 'Signature verification failed' };
      }
    } catch (err) {
      return { valid: false, error: `Verification error: ${err.message}` };
    }
  }

  /**
   * Remove challenge (on disconnect before auth)
   */
  removePending(clientId) {
    this.pendingChallenges.delete(clientId);
  }

  _cleanupExpired() {
    const now = Date.now();
    for (const [clientId, pending] of this.pendingChallenges) {
      if (now - pending.createdAt > this.challengeExpiry * 2) {
        this.pendingChallenges.delete(clientId);
      }
    }
  }
}

/**
 * Verify an ed25519 signature.
 * Uses Node.js crypto module (available in Node 16+).
 */
function verifyEd25519(message, signature, publicKey) {
  try {
    // Node.js 16+ has native ed25519 support via crypto.verify
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 public key DER prefix
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(publicKey),
      ]),
      format: 'der',
      type: 'spki',
    });

    return crypto.verify(
      null, // ed25519 doesn't use a separate hash
      Buffer.from(message),
      keyObject,
      Buffer.from(signature)
    );
  } catch (err) {
    // Fallback: if native ed25519 not available, return false
    // In production, use tweetnacl package as fallback
    console.error(`[Auth] ed25519 verify error: ${err.message}`);
    return false;
  }
}

module.exports = { WalletAuth };
