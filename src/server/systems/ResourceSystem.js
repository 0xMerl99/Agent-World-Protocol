/**
 * ResourceSystem — Biome resource spawning, gathering, and scanning.
 */

module.exports = function(WorldState) {
  const proto = WorldState.prototype;

  proto._spawnResources = function(zone) {
    const biomeResources = {
      village: [
        { type: 'wood', chance: 0.03, amount: 5, max: 10, regen: 1 },
        { type: 'stone', chance: 0.01, amount: 3, max: 6, regen: 0 },
      ],
      autumn_town: [
        { type: 'wood', chance: 0.02, amount: 4, max: 8, regen: 1 },
        { type: 'food', chance: 0.02, amount: 6, max: 10, regen: 2 },
      ],
      farmland: [
        { type: 'food', chance: 0.06, amount: 8, max: 15, regen: 3 },
        { type: 'wood', chance: 0.01, amount: 3, max: 5, regen: 1 },
      ],
      industrial: [
        { type: 'metal', chance: 0.04, amount: 5, max: 10, regen: 0 },
        { type: 'stone', chance: 0.03, amount: 6, max: 12, regen: 0 },
      ],
      wilderness: [
        { type: 'wood', chance: 0.05, amount: 8, max: 15, regen: 2 },
        { type: 'food', chance: 0.02, amount: 4, max: 8, regen: 1 },
        { type: 'stone', chance: 0.01, amount: 3, max: 6, regen: 0 },
      ],
      highlands: [
        { type: 'stone', chance: 0.05, amount: 8, max: 15, regen: 0 },
        { type: 'metal', chance: 0.03, amount: 5, max: 10, regen: 0 },
        { type: 'crystal', chance: 0.005, amount: 2, max: 3, regen: 0 },
      ],
      winter_town: [
        { type: 'wood', chance: 0.02, amount: 3, max: 6, regen: 1 },
        { type: 'ice', chance: 0.03, amount: 5, max: 10, regen: 2 },
      ],
    };

    const defs = biomeResources[zone.biome] || biomeResources.wilderness;

    for (let x = zone.originX; x < zone.originX + zone.width; x++) {
      for (let y = zone.originY; y < zone.originY + zone.height; y++) {
        for (const def of defs) {
          if (Math.random() < def.chance) {
            const key = `${x},${y}`;
            if (!this.resources.has(key)) {
              this.resources.set(key, {
                type: def.type,
                amount: def.amount,
                maxAmount: def.max,
                regenRate: def.regen,
                x, y,
                zoneId: zone.id,
                lastHarvested: null,
              });
            }
            break; // one resource per tile
          }
        }
      }
    }
  };

  proto._actionGather = function(agent, action) {
    const { x, y } = action;
    const gx = x !== undefined ? x : agent.x;
    const gy = y !== undefined ? y : agent.y;

    // Must be close
    const dist = Math.abs(gx - agent.x) + Math.abs(gy - agent.y);
    if (dist > 2) return { actionId: action.id, success: false, error: 'Too far to gather (max 2 tiles)' };

    const key = `${gx},${gy}`;
    const resource = this.resources.get(key);
    if (!resource) return { actionId: action.id, success: false, error: 'No resource at this location' };
    if (resource.amount <= 0) return { actionId: action.id, success: false, error: `${resource.type} is depleted — wait for regeneration` };

    // Gather 1-3 units
    const gathered = Math.min(resource.amount, 1 + Math.floor(Math.random() * 3));
    resource.amount -= gathered;
    resource.lastHarvested = this.tick;

    // Add to agent's inventory (stored in metadata)
    if (!agent.metadata.inventory) agent.metadata.inventory = {};
    agent.metadata.inventory[resource.type] = (agent.metadata.inventory[resource.type] || 0) + gathered;
    agent.reputation.resourcesGathered += gathered;
    this._awardXP(agent, 5, 'gather');

    this.tickEvents.push({
      type: 'resource_gathered',
      agentId: agent.id,
      agentName: agent.name,
      resourceType: resource.type,
      amount: gathered,
      remaining: resource.amount,
      x: gx, y: gy,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        resourceType: resource.type,
        gathered,
        remaining: resource.amount,
        inventory: agent.metadata.inventory,
      },
    };
  };

  proto._actionScanResources = function(agent, action) {
    const radius = Math.min(action.radius || 5, this.config.PERCEPTION_RADIUS);
    const nearby = [];

    for (const [key, res] of this.resources) {
      const dist = Math.abs(res.x - agent.x) + Math.abs(res.y - agent.y);
      if (dist <= radius && res.amount > 0) {
        nearby.push({
          type: res.type,
          amount: res.amount,
          maxAmount: res.maxAmount,
          x: res.x,
          y: res.y,
          distance: dist,
        });
      }
    }

    nearby.sort((a, b) => a.distance - b.distance);

    return {
      actionId: action.id,
      success: true,
      data: {
        resources: nearby.slice(0, 20),
        count: nearby.length,
        inventory: agent.metadata.inventory || {},
      },
    };
  };
};
