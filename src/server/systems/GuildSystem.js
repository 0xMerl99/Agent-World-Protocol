/**
 * GuildSystem — Create, join, leave, invite, kick, deposit, info.
 */

module.exports = function(WorldState, constants) {
  const { sanitize } = constants;
  const proto = WorldState.prototype;

  proto._actionCreateGuild = function(agent, action) {
    const { name, description, tag } = action;
    if (!name) return { actionId: action.id, success: false, error: 'Missing guild name' };
    if (agent.guildId) return { actionId: action.id, success: false, error: 'Already in a guild — leave first' };

    // Name uniqueness
    for (const [, guild] of this.guilds) {
      if (guild.name.toLowerCase() === name.toLowerCase()) {
        return { actionId: action.id, success: false, error: 'Guild name already taken' };
      }
    }

    // Creation cost
    const cost = 0.1e9; // 0.1 SOL
    const payment = this.spend(agent.id, cost, `create guild: ${name}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford guild creation (0.1 SOL): ${payment.error}` };
    }

    const guildId = require('uuid').v4();
    const guild = {
      id: guildId,
      name: sanitize(name).slice(0, 30),
      tag: sanitize((tag || name.slice(0, 4)).toUpperCase()).slice(0, 5),
      description: description ? sanitize(description).slice(0, 500) : '',
      leaderId: agent.id,
      leaderName: agent.name,
      members: [{ agentId: agent.id, name: agent.name, role: 'leader', joinedAt: this.tick }],
      treasury: 0,
      totalDeposited: 0,
      tilesOwned: 0,
      buildingsOwned: 0,
      createdAt: this.tick,
      invites: new Set(),
    };

    this.guilds.set(guildId, guild);
    agent.guildId = guildId;
    agent.guildRole = 'leader';

    this.tickEvents.push({
      type: 'guild_created',
      guildId,
      guildName: guild.name,
      guildTag: guild.tag,
      leaderId: agent.id,
      leaderName: agent.name,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId, name: guild.name, tag: guild.tag, role: 'leader' },
    };
  };

  proto._actionJoinGuild = function(agent, action) {
    const { guildId } = action;
    if (!guildId) return { actionId: action.id, success: false, error: 'Missing guildId' };
    if (agent.guildId) return { actionId: action.id, success: false, error: 'Already in a guild — leave first' };

    const guild = this.guilds.get(guildId);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };

    if (!guild.invites.has(agent.id)) {
      return { actionId: action.id, success: false, error: 'You need an invite to join this guild' };
    }
    if (guild.members.length >= 20) {
      return { actionId: action.id, success: false, error: 'Guild is full (max 20 members)' };
    }

    guild.invites.delete(agent.id);
    guild.members.push({ agentId: agent.id, name: agent.name, role: 'member', joinedAt: this.tick });
    agent.guildId = guildId;
    agent.guildRole = 'member';

    this.tickEvents.push({
      type: 'guild_joined',
      guildId,
      guildName: guild.name,
      agentId: agent.id,
      agentName: agent.name,
      memberCount: guild.members.length,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId, guildName: guild.name, role: 'member', memberCount: guild.members.length },
    };
  };

  proto._actionLeaveGuild = function(agent, action) {
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const guild = this.guilds.get(agent.guildId);
    if (!guild) {
      agent.guildId = null;
      agent.guildRole = null;
      return { actionId: action.id, success: true, data: { note: 'Guild not found, membership cleared' } };
    }

    // Leader can't leave — must transfer or disband
    if (guild.leaderId === agent.id) {
      if (guild.members.length > 1) {
        return { actionId: action.id, success: false, error: 'Leader cannot leave — promote someone first or kick all members' };
      }
      // Last member — disband guild
      this.guilds.delete(guild.id);
      agent.guildId = null;
      agent.guildRole = null;

      this.tickEvents.push({
        type: 'guild_disbanded',
        guildId: guild.id,
        guildName: guild.name,
        tick: this.tick,
      });

      return { actionId: action.id, success: true, data: { note: 'Guild disbanded (you were the last member)' } };
    }

    guild.members = guild.members.filter(m => m.agentId !== agent.id);
    agent.guildId = null;
    agent.guildRole = null;

    this.tickEvents.push({
      type: 'guild_left',
      guildId: guild.id,
      guildName: guild.name,
      agentId: agent.id,
      agentName: agent.name,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId: guild.id, guildName: guild.name, note: 'You left the guild' },
    };
  };

  proto._actionGuildInvite = function(agent, action) {
    const { targetAgentId } = action;
    if (!targetAgentId) return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const guild = this.guilds.get(agent.guildId);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };

    if (agent.guildRole !== 'leader' && agent.guildRole !== 'officer') {
      return { actionId: action.id, success: false, error: 'Only leaders and officers can invite' };
    }

    const target = this.agents.get(targetAgentId);
    if (!target) return { actionId: action.id, success: false, error: 'Target agent not found' };
    if (target.guildId) return { actionId: action.id, success: false, error: 'Agent is already in a guild' };

    guild.invites.add(targetAgentId);

    this.tickEvents.push({
      type: 'guild_invite',
      guildId: guild.id,
      guildName: guild.name,
      fromAgentId: agent.id,
      targetAgentId,
      targetName: target.name,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId: guild.id, guildName: guild.name, invited: targetAgentId, targetName: target.name },
    };
  };

  proto._actionGuildKick = function(agent, action) {
    const { targetAgentId } = action;
    if (!targetAgentId) return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const guild = this.guilds.get(agent.guildId);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };
    if (guild.leaderId !== agent.id) return { actionId: action.id, success: false, error: 'Only the leader can kick members' };
    if (targetAgentId === agent.id) return { actionId: action.id, success: false, error: 'Cannot kick yourself' };

    const memberIdx = guild.members.findIndex(m => m.agentId === targetAgentId);
    if (memberIdx === -1) return { actionId: action.id, success: false, error: 'Agent is not in your guild' };

    guild.members.splice(memberIdx, 1);
    const target = this.agents.get(targetAgentId);
    if (target) {
      target.guildId = null;
      target.guildRole = null;
    }

    this.tickEvents.push({
      type: 'guild_kicked',
      guildId: guild.id,
      guildName: guild.name,
      kickedAgentId: targetAgentId,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: { guildId: guild.id, kicked: targetAgentId, memberCount: guild.members.length },
    };
  };

  proto._actionGuildDeposit = function(agent, action) {
    const { amount, amountSOL } = action;
    const lamports = amount || (amountSOL ? Math.floor(amountSOL * 1e9) : 0);
    if (lamports <= 0) return { actionId: action.id, success: false, error: 'Missing or invalid amount' };
    if (!agent.guildId) return { actionId: action.id, success: false, error: 'Not in a guild' };

    const guild = this.guilds.get(agent.guildId);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };

    const payment = this.spend(agent.id, lamports, `guild treasury deposit: ${guild.name}`);
    if (!payment.success) {
      return { actionId: action.id, success: false, error: `Cannot afford: ${payment.error}` };
    }

    guild.treasury += lamports;
    guild.totalDeposited += lamports;

    this.tickEvents.push({
      type: 'guild_deposit',
      guildId: guild.id,
      guildName: guild.name,
      agentId: agent.id,
      amount: lamports,
      treasury: guild.treasury,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        guildId: guild.id,
        deposited: lamports,
        depositedSOL: lamports / 1e9,
        treasury: guild.treasury,
        treasurySOL: guild.treasury / 1e9,
      },
    };
  };

  proto._actionGuildInfo = function(agent, action) {
    const { guildId } = action;
    const id = guildId || agent.guildId;
    if (!id) return { actionId: action.id, success: false, error: 'Missing guildId and not in a guild' };

    const guild = this.guilds.get(id);
    if (!guild) return { actionId: action.id, success: false, error: 'Guild not found' };

    return {
      actionId: action.id,
      success: true,
      data: {
        id: guild.id,
        name: guild.name,
        tag: guild.tag,
        description: guild.description,
        leader: { id: guild.leaderId, name: guild.leaderName },
        members: guild.members.map(m => ({ agentId: m.agentId, name: m.name, role: m.role, joinedAt: m.joinedAt })),
        memberCount: guild.members.length,
        treasury: guild.treasury,
        treasurySOL: guild.treasury / 1e9,
        totalDeposited: guild.totalDeposited,
        createdAt: guild.createdAt,
      },
    };
  };
};
