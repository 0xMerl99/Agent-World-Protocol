/**
 * WarSystem — Alliance wars between guilds.
 */

module.exports = function(WorldState) {
  const proto = WorldState.prototype;

  proto._actionDeclareWar = function(agent, action) {
    const { targetGuildId } = action;
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const myGuild = this.guilds.get(agent.guildId);
    if (!myGuild) return { actionId: action.id, success: false, error: 'Guild not found' };
    if (myGuild.leaderId !== agent.id) return { actionId: action.id, success: false, error: 'Only the guild leader can declare war' };
    if (!targetGuildId) return { actionId: action.id, success: false, error: 'Missing targetGuildId' };
    if (targetGuildId === agent.guildId) return { actionId: action.id, success: false, error: 'Cannot declare war on your own guild' };

    const targetGuild = this.guilds.get(targetGuildId);
    if (!targetGuild) return { actionId: action.id, success: false, error: 'Target guild not found' };

    // Check not already at war with this guild
    for (const [, war] of this.wars) {
      if (war.status === 'active') {
        const involves = (war.attackerGuildId === agent.guildId && war.defenderGuildId === targetGuildId) ||
                         (war.defenderGuildId === agent.guildId && war.attackerGuildId === targetGuildId);
        if (involves) return { actionId: action.id, success: false, error: 'Already at war with this guild' };
      }
    }

    // War costs 0.05 SOL
    const cost = 50000000; // 0.05 SOL
    const payment = this.spend(agent.id, cost, `war declaration against ${targetGuild.name}`);
    if (!payment.success) return { actionId: action.id, success: false, error: `Cannot afford war: ${payment.error}` };

    const warId = require('uuid').v4();
    const war = {
      id: warId,
      attackerGuildId: agent.guildId,
      attackerGuildName: myGuild.name,
      defenderGuildId: targetGuildId,
      defenderGuildName: targetGuild.name,
      attackerScore: 0,
      defenderScore: 0,
      startTick: this.tick,
      endTick: this.tick + 600,
      status: 'active',
      kills: [],
    };

    this.wars.set(warId, war);

    this.tickEvents.push({
      type: 'war_declared',
      warId,
      attackerGuild: myGuild.name,
      defenderGuild: targetGuild.name,
      duration: 600,
      tick: this.tick,
    });

    return { actionId: action.id, success: true, data: { warId, duration: 600, endTick: war.endTick } };
  };

  proto._actionWarStatus = function(agent, action) {
    const activeWars = [];
    for (const [, war] of this.wars) {
      if (war.status !== 'active') continue;
      if (agent.guildId && (war.attackerGuildId === agent.guildId || war.defenderGuildId === agent.guildId)) {
        activeWars.push({
          warId: war.id,
          attacker: war.attackerGuildName,
          defender: war.defenderGuildName,
          attackerScore: war.attackerScore,
          defenderScore: war.defenderScore,
          ticksRemaining: war.endTick - this.tick,
        });
      }
    }
    return { actionId: action.id, success: true, data: { wars: activeWars, count: activeWars.length } };
  };

  // Score war kills — called from combat when an agent kills another
  proto._scoreWarKill = function(killerId, victimId) {
    const killer = this.agents.get(killerId);
    const victim = this.agents.get(victimId);
    if (!killer?.guildId || !victim?.guildId) return;

    for (const [, war] of this.wars) {
      if (war.status !== 'active') continue;
      if (war.attackerGuildId === killer.guildId && war.defenderGuildId === victim.guildId) {
        war.attackerScore += 10;
        war.kills.push({ killerId, victimId, side: 'attacker', tick: this.tick });
      } else if (war.defenderGuildId === killer.guildId && war.attackerGuildId === victim.guildId) {
        war.defenderScore += 10;
        war.kills.push({ killerId, victimId, side: 'defender', tick: this.tick });
      }
    }
  };
};
