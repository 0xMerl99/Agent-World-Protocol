/**
 * CombatSystem — Attack, defend, contest territory, inspect, deposit, balance, bridge.
 */

module.exports = function(WorldState, constants) {
  const { BUILDING_COST, UPGRADE_COST } = constants;
  const proto = WorldState.prototype;

  proto._actionAttack = function(agent, action) {
    // Peaceful era blocks all combat
    if (this._activeWorldEvent?.type === 'peaceful_era') {
      return { actionId: action.id, success: false, error: 'Combat is disabled during Peaceful Era' };
    }

    const { targetAgentId } = action;
    if (!targetAgentId) return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    if (targetAgentId === agent.id) return { actionId: action.id, success: false, error: 'Cannot attack yourself' };

    const target = this.agents.get(targetAgentId);
    if (!target) return { actionId: action.id, success: false, error: 'Target agent not found' };

    // Must be nearby
    const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
    if (dist > 2) return { actionId: action.id, success: false, error: 'Target too far (max 2 tiles)' };

    // Cannot attack inside buildings
    if (agent.insideBuilding) return { actionId: action.id, success: false, error: 'Cannot attack inside buildings' };

    // Cooldown — 5 ticks between attacks
    if (this.tick - agent.combat.lastAttackTick < 5) {
      return { actionId: action.id, success: false, error: `Attack cooldown — wait ${5 - (this.tick - agent.combat.lastAttackTick)} ticks` };
    }

    // Cannot attack same guild members
    if (agent.guildId && agent.guildId === target.guildId) {
      return { actionId: action.id, success: false, error: 'Cannot attack guild members' };
    }

    // Calculate damage
    const baseDamage = agent.combat.attack;
    const defense = target.combat.defending ? target.combat.defense * 2 : target.combat.defense;
    const damage = Math.max(1, baseDamage - defense + Math.floor(Math.random() * 5));

    target.combat.hp -= damage;
    agent.combat.lastAttackTick = this.tick;

    const killed = target.combat.hp <= 0;

    if (killed) {
      // Agent "defeated" — respawn at zone center with full HP
      target.combat.hp = target.combat.maxHp;
      target.combat.deaths++;
      agent.combat.kills++;

      // Defeated agent drops 10% of their balance as loot
      const lootAmount = Math.floor(this.getBalance(target.id).balance * 0.1);
      if (lootAmount > 0) {
        this.spend(target.id, lootAmount, `defeated by ${agent.name} — loot dropped`);
        this.protocolRevenue -= lootAmount; // undo protocol revenue from spend
        this.earn(agent.id, lootAmount, `defeated ${target.name} — loot collected`);
      }

      // Respawn defeated agent at zone center
      const tile = this.tiles.get(`${target.x},${target.y}`);
      const zone = tile ? this.zones.get(tile.zoneId) : [...this.zones.values()][0];
      if (zone) {
        target.x = zone.originX + Math.floor(zone.width / 2);
        target.y = zone.originY + Math.floor(zone.height / 2);
      }

      this.tickEvents.push({
        type: 'agent_defeated',
        attackerId: agent.id,
        attackerName: agent.name,
        defeatedId: target.id,
        defeatedName: target.name,
        loot: lootAmount,
        lootSOL: lootAmount / 1e9,
        tick: this.tick,
      });

      // Award combat XP
      this._awardXP(agent, 20, 'combat kill');

      // Score war kills
      this._scoreWarKill(agent.id, target.id);
    }

    this.tickEvents.push({
      type: 'combat_attack',
      attackerId: agent.id,
      attackerName: agent.name,
      targetId: target.id,
      targetName: target.name,
      damage,
      targetHp: target.combat.hp,
      targetMaxHp: target.combat.maxHp,
      killed,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        target: target.name,
        damage,
        targetHp: target.combat.hp,
        targetMaxHp: target.combat.maxHp,
        killed,
        loot: killed ? Math.floor(this.getBalance(target.id).balance * 0) : 0, // already transferred
      },
    };
  };

  proto._actionDefend = function(agent, action) {
    const { active } = action;
    agent.combat.defending = active !== false; // default true

    if (agent.combat.defending) {
      // Defending doubles defense but agent can't move
      // Also boosts defender score in any active contest on nearby tiles
      for (const [, contest] of this.contests) {
        if (contest.status === 'active' && contest.defenderId === agent.id) {
          const dist = Math.abs(contest.tileX - agent.x) + Math.abs(contest.tileY - agent.y);
          if (dist <= 2) {
            contest.defenderScore += 15; // significant defense boost
          }
        }
      }

      this.tickEvents.push({
        type: 'agent_defending',
        agentId: agent.id,
        agentName: agent.name,
        x: agent.x, y: agent.y,
        tick: this.tick,
      });
    }

    return {
      actionId: action.id,
      success: true,
      data: {
        defending: agent.combat.defending,
        defense: agent.combat.defending ? agent.combat.defense * 2 : agent.combat.defense,
        note: agent.combat.defending ? 'Defense doubled — you cannot move while defending' : 'Defense stance dropped',
      },
    };
  };

  proto._actionContestTerritory = function(agent, action) {
    const { x, y } = action;
    const cx = x !== undefined ? x : agent.x;
    const cy = y !== undefined ? y : agent.y;

    const tileKey = `${cx},${cy}`;
    const tile = this.tiles.get(tileKey);
    if (!tile) return { actionId: action.id, success: false, error: 'Invalid tile' };

    // Must be nearby
    const dist = Math.abs(cx - agent.x) + Math.abs(cy - agent.y);
    if (dist > 2) return { actionId: action.id, success: false, error: 'Too far to contest (max 2 tiles)' };

    // Must be owned by someone else
    if (!tile.owner) return { actionId: action.id, success: false, error: 'Tile is unclaimed — use claim instead' };
    if (tile.owner === agent.id) return { actionId: action.id, success: false, error: 'You already own this tile' };

    // Same guild can't contest each other
    const owner = this.agents.get(tile.owner);
    if (owner && agent.guildId && agent.guildId === owner.guildId) {
      return { actionId: action.id, success: false, error: 'Cannot contest guild member territory' };
    }

    // Check for existing contest on this tile
    for (const [, contest] of this.contests) {
      if (contest.tileX === cx && contest.tileY === cy && contest.status === 'active') {
        return { actionId: action.id, success: false, error: 'Territory already being contested' };
      }
    }

    // Contesting costs SOL (0.02 SOL — double claim cost)
    const contestCost = 0.02e9;
    const payment = this.spend(agent.id, contestCost, `contest territory (${cx},${cy})`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford contest (0.02 SOL): ${payment.error}` };
    }

    // Create contest — lasts 30 ticks
    const contestId = require('uuid').v4();
    const contest = {
      id: contestId,
      tileX: cx,
      tileY: cy,
      attackerId: agent.id,
      attackerName: agent.name,
      defenderId: tile.owner,
      defenderName: owner ? owner.name : 'Unknown',
      attackerGuild: agent.guildId,
      defenderGuild: owner ? owner.guildId : null,
      status: 'active',
      attackerScore: 10,
      defenderScore: 0,
      startedAt: this.tick,
      endsAt: this.tick + 30,
      cost: contestCost,
    };

    this.contests.set(contestId, contest);

    this.tickEvents.push({
      type: 'territory_contested',
      contestId,
      attackerId: agent.id,
      attackerName: agent.name,
      defenderId: tile.owner,
      tileX: cx, tileY: cy,
      endsAt: contest.endsAt,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        contestId,
        tileX: cx, tileY: cy,
        defender: contest.defenderName,
        endsAt: contest.endsAt,
        ticksRemaining: 30,
        cost: contestCost,
        costSOL: contestCost / 1e9,
        note: 'Contest started. Defender has 30 ticks to defend. If undefended, you take the tile.',
      },
    };
  };

  proto._actionInspect = function(agent, action) {
    const { targetAgentId } = action;
    if (!targetAgentId) {
      return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    }

    const target = this.agents.get(targetAgentId);
    if (!target) {
      return { actionId: action.id, success: false, error: 'Target agent not found' };
    }

    // Check distance
    const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
    if (dist > this.config.PERCEPTION_RADIUS) {
      return { actionId: action.id, success: false, error: 'Target out of perception range' };
    }

    return {
      actionId: action.id,
      success: true,
      data: {
        id: target.id,
        name: target.name,
        status: target.status,
        reputation: { ...target.reputation },
        buildingsOwned: [...this.buildings.values()].filter(b => b.owner === targetAgentId).map(b => ({
          id: b.id,
          type: b.type,
          x: b.x,
          y: b.y,
        })),
        connectedAt: target.connectedAt,
      }
    };
  };

  proto._actionDeposit = function(agent, action) {
    const { amount, amountSOL } = action;
    const lamports = amount || (amountSOL ? Math.floor(amountSOL * 1e9) : 0);

    if (lamports <= 0) {
      return { actionId: action.id, success: false, error: 'Missing or invalid amount' };
    }

    const result = this.deposit(agent.id, lamports, 'direct deposit');

    this.tickEvents.push({
      type: 'deposit',
      agentId: agent.id,
      amount: lamports,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        deposited: lamports,
        depositedSOL: lamports / 1e9,
        balance: result.balance,
        balanceSOL: result.balance / 1e9,
      },
    };
  };

  proto._actionBalance = function(agent, action) {
    const balanceInfo = this.getBalance(agent.id);
    const ownedTiles = [...this.tiles.values()].filter(t => t.owner === agent.id).length;
    const ownedBuildings = [...this.buildings.values()].filter(b => b.owner === agent.id);

    return {
      actionId: action.id,
      success: true,
      data: {
        ...balanceInfo,
        ownedTiles,
        ownedBuildings: ownedBuildings.length,
        buildingValues: ownedBuildings.map(b => ({
          id: b.id,
          type: b.type,
          level: b.appearance.level,
          estimatedValue: BUILDING_COST[b.type] + (b.appearance.level > 1 ? UPGRADE_COST[b.appearance.level] : 0),
        })),
      },
    };
  };

  proto._actionBridge = function(agent, action) {
    const { bridge, bridgeAction, params } = action;
    if (!bridge || !bridgeAction) {
      return { actionId: action.id, success: false, error: 'Missing bridge or bridgeAction' };
    }

    this.tickEvents.push({
      type: 'bridge_request',
      agentId: agent.id,
      bridge,
      bridgeAction,
      params,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { status: 'queued', bridge, bridgeAction } };
  };
};
