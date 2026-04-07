/**
 * EconomySystem — Ledger, deposits, spending, earning, transfers, balances.
 */

module.exports = function(WorldState) {
  const proto = WorldState.prototype;

  proto._initLedger = function(agentId) {
    if (!this.ledger.has(agentId)) {
      this.ledger.set(agentId, {
        balance: 0,
        totalDeposited: 0,
        totalSpent: 0,
        totalEarned: 0,
        history: [],
      });
    }
  };

  proto.deposit = function(agentId, amountLamports, source = 'deposit') {
    this._initLedger(agentId);
    const account = this.ledger.get(agentId);
    account.balance += amountLamports;
    account.totalDeposited += amountLamports;
    account.history.push({
      type: 'deposit',
      amount: amountLamports,
      source,
      tick: this.tick,
      timestamp: Date.now(),
    });

    this._logTransaction(agentId, 'deposit', amountLamports, source);
    return { success: true, balance: account.balance };
  };

  proto.spend = function(agentId, amountLamports, reason) {
    this._initLedger(agentId);
    const account = this.ledger.get(agentId);

    if (account.balance < amountLamports) {
      return { success: false, error: `Insufficient balance: have ${account.balance}, need ${amountLamports}`, balance: account.balance };
    }

    account.balance -= amountLamports;
    account.totalSpent += amountLamports;
    account.history.push({
      type: 'spend',
      amount: amountLamports,
      reason,
      tick: this.tick,
      timestamp: Date.now(),
    });

    // Protocol gets the revenue
    this.protocolRevenue += amountLamports;

    this._logTransaction(agentId, 'spend', amountLamports, reason);
    return { success: true, balance: account.balance };
  };

  proto.earn = function(agentId, amountLamports, source) {
    this._initLedger(agentId);
    const account = this.ledger.get(agentId);
    account.balance += amountLamports;
    account.totalEarned += amountLamports;
    account.history.push({
      type: 'earn',
      amount: amountLamports,
      source,
      tick: this.tick,
      timestamp: Date.now(),
    });

    this._logTransaction(agentId, 'earn', amountLamports, source);
    return { success: true, balance: account.balance };
  };

  proto.transfer = function(fromAgentId, toAgentId, amountLamports, reason) {
    const fromAccount = this.ledger.get(fromAgentId);
    if (!fromAccount || fromAccount.balance < amountLamports) {
      return { success: false, error: 'Insufficient balance' };
    }

    const spendResult = this.spend(fromAgentId, amountLamports, `transfer to ${toAgentId}: ${reason}`);
    if (!spendResult.success) return spendResult;

    // Transfer goes to the other agent, not protocol revenue
    this.protocolRevenue -= amountLamports;
    this.earn(toAgentId, amountLamports, `transfer from ${fromAgentId}: ${reason}`);

    return { success: true, fromBalance: this.ledger.get(fromAgentId).balance, toBalance: this.ledger.get(toAgentId).balance };
  };

  proto.getBalance = function(agentId) {
    this._initLedger(agentId);
    const account = this.ledger.get(agentId);
    return {
      balance: account.balance,
      balanceSOL: account.balance / 1e9,
      totalDeposited: account.totalDeposited,
      totalSpent: account.totalSpent,
      totalEarned: account.totalEarned,
      pnl: account.totalEarned - account.totalSpent,
      historyCount: account.history.length,
    };
  };

  proto.getTransactionHistory = function(agentId, limit = 50) {
    this._initLedger(agentId);
    return this.ledger.get(agentId).history.slice(-limit);
  };

  proto.getProtocolRevenue = function() {
    return {
      totalLamports: this.protocolRevenue,
      totalSOL: this.protocolRevenue / 1e9,
      transactionCount: this.transactionLog.length,
    };
  };

  proto._logTransaction = function(agentId, type, amount, reason) {
    this.transactionLog.push({
      agentId,
      type,
      amount,
      reason,
      tick: this.tick,
      timestamp: Date.now(),
    });
    // Keep manageable
    if (this.transactionLog.length > 10000) {
      this.transactionLog = this.transactionLog.slice(-5000);
    }
  };
};
