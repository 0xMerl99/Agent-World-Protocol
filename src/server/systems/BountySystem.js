/**
 * BountySystem — Post, claim, submit, accept, reject, cancel, list bounties.
 */

module.exports = function(WorldState, constants) {
  const { BOUNTY_MIN_REWARD, BOUNTY_STAKE_PERCENT, BOUNTY_DEFAULT_TIMEOUT, BOUNTY_PROTOCOL_FEE_BPS } = constants;
  const proto = WorldState.prototype;

  proto._actionPostBounty = function(agent, action) {
    const { title, description, reward, rewardSOL, deadline, tags, minReputation, maxClaims } = action;

    if (!title) return { actionId: action.id, success: false, error: 'Missing bounty title' };
    if (!description) return { actionId: action.id, success: false, error: 'Missing bounty description' };

    const rewardLamports = reward || (rewardSOL ? Math.floor(rewardSOL * 1e9) : 0);
    if (rewardLamports < BOUNTY_MIN_REWARD) {
      return { actionId: action.id, success: false, error: `Minimum reward is ${BOUNTY_MIN_REWARD / 1e9} SOL` };
    }

    // Per-agent bounty limit and duplicate check
    let activeCount = 0;
    for (const [, existing] of this.bounties) {
      if (existing.creatorId === agent.id && (existing.status === 'open' || existing.status === 'claimed' || existing.status === 'submitted')) {
        activeCount++;
        if (existing.title === title && existing.status === 'open') {
          return { actionId: action.id, success: false, error: 'You already have an open bounty with this title' };
        }
      }
    }
    if (activeCount >= 10) return { actionId: action.id, success: false, error: 'Max 10 active bounties per agent' };

    // Lock reward in escrow (deduct from creator's balance)
    const payment = this.spend(agent.id, rewardLamports, `bounty escrow: ${title}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford bounty reward: ${payment.error}` };
    }
    // spend() added to protocolRevenue but this is escrow, not revenue
    this.protocolRevenue -= rewardLamports;

    const bountyId = require('uuid').v4();
    const bounty = {
      id: bountyId,
      title: title.slice(0, 200),
      description: description.slice(0, 2000),
      reward: rewardLamports,
      creatorId: agent.id,
      creatorName: agent.name,
      creatorWallet: agent.wallet,
      status: 'open',
      tags: tags || [],
      minReputation: minReputation || 0,
      maxClaims: maxClaims || 1,
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      stake: 0,
      submission: null,
      submittedAt: null,
      completedAt: null,
      deadline: deadline ? this.tick + deadline : this.tick + 3000,
      createdAt: this.tick,
      createdAtTime: Date.now(),
    };

    this.bounties.set(bountyId, bounty);
    agent.reputation.bountiesPosted++;

    this.tickEvents.push({
      type: 'bounty_posted',
      bountyId,
      creatorId: agent.id,
      creatorName: agent.name,
      title: bounty.title,
      reward: rewardLamports,
      rewardSOL: rewardLamports / 1e9,
      deadline: bounty.deadline,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        reward: rewardLamports,
        rewardSOL: rewardLamports / 1e9,
        deadline: bounty.deadline,
        status: 'open',
      },
    };
  };

  proto._actionClaimBounty = function(agent, action) {
    const { bountyId } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.status !== 'open') return { actionId: action.id, success: false, error: `Bounty is ${bounty.status}, not open` };
    if (bounty.creatorId === agent.id) return { actionId: action.id, success: false, error: 'Cannot claim your own bounty' };

    // Check minimum reputation
    if (bounty.minReputation > 0) {
      const rep = agent.reputation.bountiesCompleted - agent.reputation.bountiesAbandoned;
      if (rep < bounty.minReputation) {
        return { actionId: action.id, success: false, error: `Requires reputation ${bounty.minReputation}, you have ${rep}` };
      }
    }

    // Stake 10% of reward
    const stakeAmount = Math.floor(bounty.reward * BOUNTY_STAKE_PERCENT / 100);
    if (stakeAmount > 0) {
      const stakePayment = this.spend(agent.id, stakeAmount, `bounty stake: ${bounty.title}`);
      if (!stakePayment.success) {
        return { actionId: action.id, success: false, error: `Cannot afford stake (${stakeAmount / 1e9} SOL): ${stakePayment.error}` };
      }
      // spend() added to protocolRevenue but stake is escrow, not revenue
      this.protocolRevenue -= stakeAmount;
    }

    bounty.status = 'claimed';
    bounty.claimedBy = agent.id;
    bounty.claimedAt = this.tick;
    bounty.stake = stakeAmount;
    bounty.claimExpiresAt = this.tick + (action.timeout || BOUNTY_DEFAULT_TIMEOUT);

    this.tickEvents.push({
      type: 'bounty_claimed',
      bountyId,
      agentId: agent.id,
      agentName: agent.name,
      title: bounty.title,
      stake: stakeAmount,
      expiresAt: bounty.claimExpiresAt,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        reward: bounty.reward,
        rewardSOL: bounty.reward / 1e9,
        staked: stakeAmount,
        stakedSOL: stakeAmount / 1e9,
        claimExpiresAt: bounty.claimExpiresAt,
        ticksRemaining: bounty.claimExpiresAt - this.tick,
      },
    };
  };

  proto._actionSubmitBounty = function(agent, action) {
    const { bountyId, proof, notes } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };
    if (!proof) return { actionId: action.id, success: false, error: 'Missing proof of completion' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.claimedBy !== agent.id) return { actionId: action.id, success: false, error: 'You have not claimed this bounty' };
    if (bounty.status !== 'claimed') return { actionId: action.id, success: false, error: `Bounty is ${bounty.status}, not claimed` };

    bounty.status = 'submitted';
    bounty.submission = {
      proof: typeof proof === 'string' ? proof.slice(0, 5000) : JSON.stringify(proof).slice(0, 5000),
      notes: notes ? notes.slice(0, 1000) : '',
      submittedBy: agent.id,
      submittedAt: this.tick,
    };
    bounty.submittedAt = this.tick;

    this.tickEvents.push({
      type: 'bounty_submitted',
      bountyId,
      agentId: agent.id,
      agentName: agent.name,
      title: bounty.title,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        status: 'submitted',
        note: 'Waiting for creator to review and accept/reject.',
      },
    };
  };

  proto._actionAcceptSubmission = function(agent, action) {
    const { bountyId } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.creatorId !== agent.id) return { actionId: action.id, success: false, error: 'Only the bounty creator can accept submissions' };
    if (bounty.status !== 'submitted') return { actionId: action.id, success: false, error: `Bounty is ${bounty.status}, not submitted` };

    // Double bounty event doubles the reward
    const reward = (this._activeWorldEvent?.type === 'double_bounty') ? bounty.reward * 2 : bounty.reward;

    // Calculate fee
    const protocolFee = Math.floor(reward * BOUNTY_PROTOCOL_FEE_BPS / 10000);
    const agentReceives = reward - protocolFee;

    // Pay the agent (reward minus protocol fee)
    this.earn(bounty.claimedBy, agentReceives, `bounty completed: ${bounty.title}`);

    // Return stake to agent
    if (bounty.stake > 0) {
      this.earn(bounty.claimedBy, bounty.stake, `bounty stake returned: ${bounty.title}`);
    }

    // Protocol collects fee
    this.protocolRevenue += protocolFee;

    // Update reputations
    const claimer = this.agents.get(bounty.claimedBy);
    if (claimer) {
      claimer.reputation.bountiesCompleted++;
      claimer.reputation.bountyEarnings += agentReceives;
    }

    bounty.status = 'completed';
    bounty.completedAt = this.tick;

    this.tickEvents.push({
      type: 'bounty_completed',
      bountyId,
      creatorId: agent.id,
      agentId: bounty.claimedBy,
      title: bounty.title,
      reward: bounty.reward,
      protocolFee,
      agentReceived: agentReceives,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        status: 'completed',
        agentReceived: agentReceives,
        agentReceivedSOL: agentReceives / 1e9,
        protocolFee,
        protocolFeeSOL: protocolFee / 1e9,
        stakeReturned: bounty.stake,
      },
    };
  };

  proto._actionRejectSubmission = function(agent, action) {
    const { bountyId, reason } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.creatorId !== agent.id) return { actionId: action.id, success: false, error: 'Only the bounty creator can reject submissions' };
    if (bounty.status !== 'submitted') return { actionId: action.id, success: false, error: `Bounty is ${bounty.status}, not submitted` };

    // Go back to claimed — agent can try again within the timeout
    bounty.status = 'claimed';
    bounty.submission = null;
    bounty.submittedAt = null;

    this.tickEvents.push({
      type: 'bounty_rejected',
      bountyId,
      creatorId: agent.id,
      agentId: bounty.claimedBy,
      title: bounty.title,
      reason: reason || 'Submission did not meet requirements',
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        status: 'claimed',
        reason: reason || 'Submission rejected. Agent can retry before timeout.',
        ticksRemaining: bounty.claimExpiresAt - this.tick,
      },
    };
  };

  proto._actionCancelBounty = function(agent, action) {
    const { bountyId } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.creatorId !== agent.id) return { actionId: action.id, success: false, error: 'Only the creator can cancel' };
    if (bounty.status !== 'open') return { actionId: action.id, success: false, error: `Cannot cancel — bounty is ${bounty.status}` };

    // Refund reward
    this.earn(agent.id, bounty.reward, `bounty cancelled, refund: ${bounty.title}`);

    bounty.status = 'cancelled';

    this.tickEvents.push({
      type: 'bounty_cancelled',
      bountyId,
      creatorId: agent.id,
      title: bounty.title,
      refund: bounty.reward,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { bountyId, status: 'cancelled', refunded: bounty.reward, refundedSOL: bounty.reward / 1e9 },
    };
  };

  // --- DISPUTE BOUNTY ---
  // The claimer can dispute a rejection. Triggers community vote via reputation-weighted scoring.
  proto._actionDisputeBounty = function(agent, action) {
    const { bountyId, reason } = action;
    if (!bountyId) return { actionId: action.id, success: false, error: 'Missing bountyId' };

    const bounty = this.bounties.get(bountyId);
    if (!bounty) return { actionId: action.id, success: false, error: 'Bounty not found' };
    if (bounty.claimedBy !== agent.id) return { actionId: action.id, success: false, error: 'Only the claimer can dispute' };
    if (bounty.status !== 'claimed') return { actionId: action.id, success: false, error: `Cannot dispute — bounty is ${bounty.status}` };
    if (bounty._disputed) return { actionId: action.id, success: false, error: 'Already disputed' };

    // Dispute cost: 5% of reward (non-refundable — protocol revenue)
    const disputeCost = Math.floor(bounty.reward * 0.05);
    if (disputeCost > 0) {
      const payment = this.spend(agent.id, disputeCost, `bounty dispute fee: ${bounty.title}`);
      if (!payment.success) {
        return { actionId: action.id, success: false, error: `Cannot afford dispute fee (${disputeCost / 1e9} SOL)` };
      }
      // spend() already added disputeCost to protocolRevenue — this IS protocol revenue, no undo needed
    }

    bounty._disputed = true;
    bounty._disputeReason = (reason || 'Work was completed as specified').slice(0, 1000);
    bounty._disputeTick = this.tick;
    // Extend claim timeout to allow resolution
    bounty.claimExpiresAt = this.tick + 200;

    this.tickEvents.push({
      type: 'bounty_disputed',
      bountyId,
      agentId: agent.id,
      agentName: agent.name,
      creatorId: bounty.creatorId,
      title: bounty.title,
      reason: bounty._disputeReason,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        bountyId,
        title: bounty.title,
        status: 'disputed',
        disputeCost,
        disputeCostSOL: disputeCost / 1e9,
        note: 'Dispute filed. The bounty creator can accept to resolve, or it will auto-resolve based on agent reputations after timeout.',
      },
    };
  };

  proto._actionListBounties = function(agent, action) {
    const { status, tag, limit } = action;
    const filterStatus = status || 'open';
    const maxResults = Math.min(limit || 20, 50);

    let results = [...this.bounties.values()];

    // Filter by status
    if (filterStatus !== 'all') {
      results = results.filter(b => b.status === filterStatus);
    }

    // Filter by tag
    if (tag) {
      results = results.filter(b => b.tags.includes(tag));
    }

    // Sort by reward (highest first)
    results.sort((a, b) => b.reward - a.reward);
    results = results.slice(0, maxResults);

    return {
      actionId: action.id,
      success: true,
      data: {
        bounties: results.map(b => ({
          id: b.id,
          title: b.title,
          description: b.description.slice(0, 200),
          reward: b.reward,
          rewardSOL: b.reward / 1e9,
          status: b.status,
          creatorName: b.creatorName,
          tags: b.tags,
          minReputation: b.minReputation,
          deadline: b.deadline,
          ticksRemaining: b.deadline - this.tick,
          claimedBy: b.claimedBy,
          createdAt: b.createdAt,
        })),
        count: results.length,
        totalBounties: this.bounties.size,
      },
    };
  };
};
