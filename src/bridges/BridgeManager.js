/**
 * BridgeManager — Routes bridge actions from the world to external services.
 * 
 * Each bridge is a module that handles a specific external integration.
 * The BridgeManager validates requests, enforces rate limits and fees,
 * and returns results back to the world state.
 */

class BridgeManager {
  constructor(worldState, options = {}) {
    this.world = worldState;
    this.bridges = new Map();
    this.feeCollector = options.feeCollectorWallet || null;
    this.transactionLog = []; // audit trail

    // Rate limiting per agent
    this.rateLimits = new Map(); // agentId -> { lastAction: timestamp, count: number }
    this.maxActionsPerMinute = options.maxActionsPerMinute || 10;
  }

  /**
   * Register a bridge module
   */
  register(name, bridge) {
    this.bridges.set(name, bridge);
    console.log(`[BridgeManager] Registered bridge: ${name}`);
  }

  /**
   * Execute a bridge action for an agent
   */
  async execute(agentId, bridgeName, action, params) {
    const agent = this.world.getAgent(agentId);
    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }

    // Check if bridge exists
    const bridge = this.bridges.get(bridgeName);
    if (!bridge) {
      return { success: false, error: `Bridge '${bridgeName}' not found. Available: ${[...this.bridges.keys()].join(', ')}` };
    }

    // Rate limiting
    if (!this._checkRateLimit(agentId)) {
      return { success: false, error: 'Rate limit exceeded. Max 10 bridge actions per minute.' };
    }

    // Check operator spending limits
    if (agent.controls.maxSpendPerTick && params.amount) {
      if (params.amount > agent.controls.maxSpendPerTick) {
        return { success: false, error: `Amount ${params.amount} exceeds operator spending limit of ${agent.controls.maxSpendPerTick}` };
      }
    }

    // Execute through the bridge
    try {
      const startTime = Date.now();
      const result = await bridge.execute(action, {
        ...params,
        agentWallet: agent.wallet,
        agentId: agent.id,
      });
      const duration = Date.now() - startTime;

      // Log transaction
      const logEntry = {
        timestamp: Date.now(),
        agentId,
        agentName: agent.name,
        bridge: bridgeName,
        action,
        params,
        result: {
          success: result.success,
          data: result.data,
          error: result.error,
          fee: result.fee || 0,
        },
        duration,
      };
      this.transactionLog.push(logEntry);

      // Keep log manageable
      if (this.transactionLog.length > 10000) {
        this.transactionLog = this.transactionLog.slice(-5000);
      }

      // Update agent reputation on successful trade
      if (result.success && (action === 'swap' || action === 'buy' || action === 'sell')) {
        agent.reputation.tradesCompleted++;
        agent.reputation.totalVolumeTraded += (params.amount || 0);
      }

      return result;

    } catch (err) {
      console.error(`[BridgeManager] Bridge '${bridgeName}' error:`, err.message);
      return { success: false, error: `Bridge error: ${err.message}` };
    }
  }

  _checkRateLimit(agentId) {
    const now = Date.now();
    const limit = this.rateLimits.get(agentId);

    if (!limit) {
      this.rateLimits.set(agentId, { lastReset: now, count: 1 });
      return true;
    }

    // Reset every minute
    if (now - limit.lastReset > 60000) {
      limit.lastReset = now;
      limit.count = 1;
      return true;
    }

    if (limit.count >= this.maxActionsPerMinute) {
      return false;
    }

    limit.count++;
    return true;
  }

  /**
   * Get transaction history for an agent
   */
  getAgentTransactions(agentId, limit = 50) {
    return this.transactionLog
      .filter(t => t.agentId === agentId)
      .slice(-limit);
  }

  /**
   * Get all transaction stats
   */
  getStats() {
    const totalTransactions = this.transactionLog.length;
    const successCount = this.transactionLog.filter(t => t.result.success).length;
    const totalFees = this.transactionLog.reduce((sum, t) => sum + (t.result.fee || 0), 0);

    const bridgeStats = {};
    for (const [name] of this.bridges) {
      const bridgeTx = this.transactionLog.filter(t => t.bridge === name);
      bridgeStats[name] = {
        total: bridgeTx.length,
        success: bridgeTx.filter(t => t.result.success).length,
        fees: bridgeTx.reduce((sum, t) => sum + (t.result.fee || 0), 0),
      };
    }

    return {
      totalTransactions,
      successRate: totalTransactions > 0 ? (successCount / totalTransactions * 100).toFixed(1) + '%' : '0%',
      totalFees,
      bridges: bridgeStats,
    };
  }
}

module.exports = { BridgeManager };
