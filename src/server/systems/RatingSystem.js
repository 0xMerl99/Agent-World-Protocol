/**
 * RatingSystem — Agent-to-agent reputation ratings (1-5 stars).
 */

module.exports = function(WorldState) {
  const proto = WorldState.prototype;

  proto._actionRateAgent = function(agent, action) {
    const { targetAgentId, score, comment } = action;
    if (!targetAgentId) return { actionId: action.id, success: false, error: 'Missing targetAgentId' };
    if (targetAgentId === agent.id) return { actionId: action.id, success: false, error: 'Cannot rate yourself' };
    if (score === undefined || score < 1 || score > 5) return { actionId: action.id, success: false, error: 'Score must be 1-5' };

    const target = this.agents.get(targetAgentId);
    if (!target) return { actionId: action.id, success: false, error: 'Target agent not found' };

    // Must be within perception range
    const dist = Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y);
    if (dist > this.config.PERCEPTION_RADIUS) {
      return { actionId: action.id, success: false, error: 'Agent too far — must be within perception range' };
    }

    // One rating per pair (can update)
    const ratingKey = `${agent.id}:${targetAgentId}`;
    const existing = this.ratings.get(ratingKey);

    this.ratings.set(ratingKey, {
      fromId: agent.id,
      fromName: agent.name,
      toId: targetAgentId,
      toName: target.name,
      score: Math.floor(score),
      comment: comment ? comment.slice(0, 200) : '',
      tick: this.tick,
      updated: existing ? true : false,
    });

    // Recalculate target's average rating
    let totalScore = 0;
    let count = 0;
    for (const [key, rating] of this.ratings) {
      if (key.endsWith(`:${targetAgentId}`)) {
        totalScore += rating.score;
        count++;
      }
    }
    target.reputation.ratingsReceived = count;
    target.reputation.averageRating = count > 0 ? Math.round((totalScore / count) * 10) / 10 : 0;

    this.tickEvents.push({
      type: 'agent_rated',
      fromAgentId: agent.id,
      toAgentId: targetAgentId,
      score: Math.floor(score),
      averageRating: target.reputation.averageRating,
      tick: this.tick,
    });

    return {
      actionId: action.id,
      success: true,
      data: {
        targetAgentId,
        targetName: target.name,
        score: Math.floor(score),
        averageRating: target.reputation.averageRating,
        totalRatings: count,
        updated: existing ? true : false,
      },
    };
  };

  proto._actionGetRatings = function(agent, action) {
    const { targetAgentId } = action;
    const targetId = targetAgentId || agent.id;
    const target = this.agents.get(targetId);
    if (!target) return { actionId: action.id, success: false, error: 'Agent not found' };

    const ratings = [];
    for (const [key, rating] of this.ratings) {
      if (key.endsWith(`:${targetId}`)) {
        ratings.push({
          fromId: rating.fromId,
          fromName: rating.fromName,
          score: rating.score,
          comment: rating.comment,
          tick: rating.tick,
        });
      }
    }
    ratings.sort((a, b) => b.tick - a.tick);

    return {
      actionId: action.id,
      success: true,
      data: {
        agentId: targetId,
        agentName: target.name,
        averageRating: target.reputation.averageRating,
        totalRatings: target.reputation.ratingsReceived,
        ratings: ratings.slice(0, 20),
      },
    };
  };
};
