/**
 * LandSystem — Land claiming, building upgrades, and land sales.
 */

module.exports = function(WorldState, constants) {
  const { LAND_CLAIM_COST, BUILDING_COST, UPGRADE_COST } = constants;
  const proto = WorldState.prototype;

  proto._actionClaim = function(agent, action) {
    const { x, y } = action;
    const cx = x !== undefined ? x : agent.x;
    const cy = y !== undefined ? y : agent.y;

    // Must be close
    const dist = Math.abs(cx - agent.x) + Math.abs(cy - agent.y);
    if (dist > 2) {
      return { actionId: action.id, success: false, error: 'Too far to claim (max 2 tiles)' };
    }

    const tileKey = `${cx},${cy}`;
    const tile = this.tiles.get(tileKey);
    if (!tile) {
      return { actionId: action.id, success: false, error: 'Invalid tile' };
    }
    if (tile.owner) {
      return { actionId: action.id, success: false, error: `Tile already claimed by ${tile.owner}` };
    }

    // Pay claim cost
    const cost = LAND_CLAIM_COST;
    const payment = this.spend(agent.id, cost, `land claim (${cx},${cy})`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford land claim: ${payment.error}` };
    }

    // Claim the tile
    tile.owner = agent.id;
    tile.claimedAt = this.tick;

    this.tickEvents.push({
      type: 'land_claimed',
      agentId: agent.id,
      x: cx,
      y: cy,
      cost,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { x: cx, y: cy, cost, costSOL: cost / 1e9, balance: payment.balance },
    };
  };

  proto._actionUpgrade = function(agent, action) {
    const { buildingId } = action;
    if (!buildingId) {
      return { actionId: action.id, success: false, error: 'Missing buildingId' };
    }

    const building = this.buildings.get(buildingId);
    if (!building) {
      return { actionId: action.id, success: false, error: 'Building not found' };
    }
    if (building.owner !== agent.id) {
      return { actionId: action.id, success: false, error: 'Not your building' };
    }

    const currentLevel = building.appearance.level;
    const nextLevel = currentLevel + 1;
    if (nextLevel > 3) {
      return { actionId: action.id, success: false, error: 'Building already at max level (3)' };
    }

    const cost = UPGRADE_COST[nextLevel];
    if (!cost) {
      return { actionId: action.id, success: false, error: 'Invalid upgrade level' };
    }

    // Pay upgrade cost
    const payment = this.spend(agent.id, cost, `upgrade ${building.type} to level ${nextLevel}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford upgrade: ${payment.error}` };
    }

    // Apply upgrade
    building.appearance.level = nextLevel;

    this.tickEvents.push({
      type: 'building_upgraded',
      agentId: agent.id,
      buildingId,
      buildingType: building.type,
      level: nextLevel,
      cost,
      x: building.x,
      y: building.y,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { buildingId, level: nextLevel, cost, costSOL: cost / 1e9, balance: payment.balance },
    };
  };

  proto._actionSellLand = function(agent, action) {
    const { x, y, price, buyerAgentId } = action;

    const tileKey = `${x},${y}`;
    const tile = this.tiles.get(tileKey);
    if (!tile) return { actionId: action.id, success: false, error: 'Invalid tile' };
    if (tile.owner !== agent.id) return { actionId: action.id, success: false, error: 'Not your land' };
    if (!buyerAgentId || !price) return { actionId: action.id, success: false, error: 'Missing buyerAgentId or price' };

    const buyer = this.agents.get(buyerAgentId);
    if (!buyer) return { actionId: action.id, success: false, error: 'Buyer not found' };

    // Buyer pays
    const payment = this.spend(buyerAgentId, price, `buy land (${x},${y}) from ${agent.id}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Buyer cannot afford: ${payment.error}` };
    }

    // Seller receives (minus 2% protocol fee)
    const protocolCut = Math.floor(price * 0.02);
    const sellerReceives = price - protocolCut;
    this.earn(agent.id, sellerReceives, `sold land (${x},${y}) to ${buyerAgentId}`);
    this.protocolRevenue += protocolCut;

    // Transfer ownership
    tile.owner = buyerAgentId;

    this.tickEvents.push({
      type: 'land_sold',
      fromAgentId: agent.id,
      toAgentId: buyerAgentId,
      x, y,
      price,
      protocolFee: protocolCut,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { x, y, price, priceSOL: price / 1e9, buyer: buyerAgentId, sellerReceived: sellerReceives },
    };
  };
};
