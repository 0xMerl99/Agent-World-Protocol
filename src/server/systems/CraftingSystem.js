/**
 * CraftingSystem — XP/leveling and item crafting.
 */

module.exports = function(WorldState, constants) {
  const { CRAFTING_RECIPES } = constants;
  const proto = WorldState.prototype;

  proto._awardXP = function(agent, amount, reason) {
    if (!agent || amount <= 0) return { leveled: false };
    agent.xp = (agent.xp || 0) + amount;
    const nextLevelXP = (agent.level || 1) * 100;
    if (agent.xp >= nextLevelXP) {
      agent.level = (agent.level || 1) + 1;
      agent.xp -= nextLevelXP;
      // Stat boosts
      if (agent.combat) {
        agent.combat.maxHp += 5;
        agent.combat.hp = Math.min(agent.combat.hp + 5, agent.combat.maxHp);
        agent.combat.attack = (agent.combat.attack || 10) + 1;
        agent.combat.defense = (agent.combat.defense || 5) + 1;
      }
      this.tickEvents.push({ type: 'agent_leveled_up', agentId: agent.id, name: agent.name, level: agent.level, tick: this.tick });
      return { leveled: true, newLevel: agent.level };
    }
    return { leveled: false };
  };

  proto._actionCraft = function(agent, action) {
    const { recipe } = action;
    if (!recipe || !CRAFTING_RECIPES[recipe]) {
      return { actionId: action.id, success: false, error: `Unknown recipe: ${recipe}. Available: ${Object.keys(CRAFTING_RECIPES).join(', ')}` };
    }

    const def = CRAFTING_RECIPES[recipe];
    const inv = agent.metadata.inventory || {};

    // Check ingredients
    for (const [item, needed] of Object.entries(def.ingredients)) {
      if ((inv[item] || 0) < needed) {
        return { actionId: action.id, success: false, error: `Need ${needed} ${item}, have ${inv[item] || 0}` };
      }
    }

    // Deduct ingredients
    for (const [item, needed] of Object.entries(def.ingredients)) {
      inv[item] -= needed;
      if (inv[item] <= 0) delete inv[item];
    }

    // Add crafted item
    inv[recipe] = (inv[recipe] || 0) + 1;
    agent.metadata.inventory = inv;

    // Award XP
    this._awardXP(agent, def.xp, `crafted ${recipe}`);

    this.tickEvents.push({ type: 'crafted_item', agentId: agent.id, name: agent.name, item: recipe, tick: this.tick });

    return { actionId: action.id, success: true, data: { crafted: recipe, inventory: inv, xpGained: def.xp } };
  };
};
