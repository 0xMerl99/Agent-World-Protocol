/**
 * SocialBridge — Social media actions for agents.
 * 
 * Actions:
 * - postTweet: Post to X (Twitter)
 * - replyTweet: Reply to a tweet
 * - getTweet: Get tweet content
 * - getTimeline: Get recent tweets from an account
 * - searchTweets: Search X for keywords
 * - sendTelegram: Send message to a Telegram chat
 * - sendDiscord: Send message to a Discord webhook
 * - postAll: Broadcast to all configured platforms at once
 * 
 * Agents configure their social credentials via operator controls.
 * Protocol takes no fee on social actions — they drive attention to the world.
 */

const https = require('https');

class SocialBridge {
  constructor(options = {}) {
    this.dryRun = options.dryRun !== undefined ? options.dryRun : true;

    // Agent social credentials: agentId -> { twitter: { bearer }, telegram: { botToken, chatId }, discord: { webhookUrl } }
    this.credentials = new Map();

    // Post history for dry-run tracking
    this.postHistory = [];
    this.postCounter = 0;

    console.log(`[SocialBridge] Initialized (dryRun: ${this.dryRun})`);
  }

  async execute(action, params) {
    switch (action) {
      case 'postTweet':
        return this._postTweet(params);
      case 'replyTweet':
        return this._replyTweet(params);
      case 'getTweet':
        return this._getTweet(params);
      case 'getTimeline':
        return this._getTimeline(params);
      case 'searchTweets':
        return this._searchTweets(params);
      case 'sendTelegram':
        return this._sendTelegram(params);
      case 'sendDiscord':
        return this._sendDiscord(params);
      case 'postAll':
        return this._postAll(params);
      case 'setCredentials':
        return this._setCredentials(params);
      case 'getHistory':
        return this._getHistory(params);
      default:
        return { success: false, error: `Unknown social action: ${action}` };
    }
  }

  // --- SET CREDENTIALS ---
  _setCredentials(params) {
    const { agentId, platform, credentials } = params;
    if (!agentId || !platform || !credentials) {
      return { success: false, error: 'Missing agentId, platform, or credentials' };
    }

    if (!this.credentials.has(agentId)) {
      this.credentials.set(agentId, {});
    }

    const agentCreds = this.credentials.get(agentId);
    agentCreds[platform] = credentials;

    return {
      success: true,
      data: {
        agentId,
        platform,
        configured: true,
        platforms: Object.keys(agentCreds),
      },
    };
  }

  // --- POST TWEET ---
  async _postTweet(params) {
    const { text, agentId, agentWallet } = params;
    if (!text) return { success: false, error: 'Missing tweet text' };
    if (text.length > 280) return { success: false, error: `Tweet too long: ${text.length}/280 characters` };

    this.postCounter++;
    const post = {
      id: `post-${this.postCounter}`,
      platform: 'twitter',
      text,
      agentId,
      timestamp: Date.now(),
    };
    this.postHistory.push(post);

    if (this.dryRun) {
      return {
        success: true,
        data: {
          type: 'tweet',
          status: 'simulated (dry run)',
          text,
          tweetId: post.id,
          characterCount: text.length,
        },
      };
    }

    // Production: use Twitter API v2
    const creds = this.credentials.get(agentId);
    if (!creds || !creds.twitter) {
      return { success: false, error: 'Twitter credentials not configured. Use setCredentials first.' };
    }

    try {
      const result = await this._httpPost('https://api.twitter.com/2/tweets', { text }, {
        'Authorization': `Bearer ${creds.twitter.bearer}`,
      });
      return { success: true, data: { type: 'tweet', tweetId: result.data?.id, text } };
    } catch (err) {
      return { success: false, error: `Tweet failed: ${err.message}` };
    }
  }

  // --- REPLY TWEET ---
  async _replyTweet(params) {
    const { text, tweetId, agentId } = params;
    if (!text || !tweetId) return { success: false, error: 'Missing text or tweetId' };

    this.postCounter++;
    this.postHistory.push({
      id: `reply-${this.postCounter}`,
      platform: 'twitter',
      type: 'reply',
      text,
      replyTo: tweetId,
      agentId,
      timestamp: Date.now(),
    });

    if (this.dryRun) {
      return {
        success: true,
        data: { type: 'reply', status: 'simulated (dry run)', text, replyTo: tweetId },
      };
    }

    const creds = this.credentials.get(agentId);
    if (!creds || !creds.twitter) {
      return { success: false, error: 'Twitter credentials not configured' };
    }

    try {
      const result = await this._httpPost('https://api.twitter.com/2/tweets', {
        text,
        reply: { in_reply_to_tweet_id: tweetId },
      }, { 'Authorization': `Bearer ${creds.twitter.bearer}` });
      return { success: true, data: { type: 'reply', tweetId: result.data?.id, replyTo: tweetId } };
    } catch (err) {
      return { success: false, error: `Reply failed: ${err.message}` };
    }
  }

  // --- GET TWEET ---
  async _getTweet(params) {
    const { tweetId } = params;
    if (!tweetId) return { success: false, error: 'Missing tweetId' };

    if (this.dryRun) {
      const local = this.postHistory.find(p => p.id === tweetId || p.tweetId === tweetId);
      if (local) return { success: true, data: local };
      return { success: false, error: 'Tweet not found (dry run — only local posts are tracked)' };
    }

    try {
      const data = await this._httpGet(`https://api.twitter.com/2/tweets/${tweetId}`);
      return { success: true, data: data.data };
    } catch (err) {
      return { success: false, error: `Get tweet failed: ${err.message}` };
    }
  }

  // --- SEARCH TWEETS ---
  async _searchTweets(params) {
    const { query, limit } = params;
    if (!query) return { success: false, error: 'Missing search query' };

    if (this.dryRun) {
      return {
        success: true,
        data: {
          query,
          results: [],
          note: 'Search not available in dry-run mode. Configure Twitter API credentials for live search.',
        },
      };
    }

    try {
      const encoded = encodeURIComponent(query);
      const data = await this._httpGet(`https://api.twitter.com/2/tweets/search/recent?query=${encoded}&max_results=${limit || 10}`);
      return { success: true, data: { query, results: data.data || [] } };
    } catch (err) {
      return { success: false, error: `Search failed: ${err.message}` };
    }
  }

  // --- GET TIMELINE ---
  async _getTimeline(params) {
    const { username, limit } = params;
    if (!username) return { success: false, error: 'Missing username' };

    if (this.dryRun) {
      return {
        success: true,
        data: { username, tweets: [], note: 'Timeline not available in dry-run mode.' },
      };
    }

    return { success: false, error: 'Timeline requires Twitter API v2 with user lookup. Configure credentials.' };
  }

  // --- SEND TELEGRAM ---
  async _sendTelegram(params) {
    const { text, agentId, chatId, parseMode } = params;
    if (!text) return { success: false, error: 'Missing message text' };

    this.postCounter++;
    this.postHistory.push({
      id: `tg-${this.postCounter}`,
      platform: 'telegram',
      text,
      agentId,
      chatId,
      timestamp: Date.now(),
    });

    if (this.dryRun) {
      return {
        success: true,
        data: { type: 'telegram', status: 'simulated (dry run)', text, chatId: chatId || 'default' },
      };
    }

    const creds = this.credentials.get(agentId);
    if (!creds || !creds.telegram) {
      return { success: false, error: 'Telegram credentials not configured' };
    }

    const targetChat = chatId || creds.telegram.chatId;
    try {
      const url = `https://api.telegram.org/bot${creds.telegram.botToken}/sendMessage`;
      const result = await this._httpPost(url, {
        chat_id: targetChat,
        text,
        parse_mode: parseMode || 'HTML',
      });
      return { success: true, data: { type: 'telegram', messageId: result.result?.message_id, chatId: targetChat } };
    } catch (err) {
      return { success: false, error: `Telegram failed: ${err.message}` };
    }
  }

  // --- SEND DISCORD ---
  async _sendDiscord(params) {
    const { text, agentId, username, avatarUrl } = params;
    if (!text) return { success: false, error: 'Missing message text' };

    this.postCounter++;
    this.postHistory.push({
      id: `dc-${this.postCounter}`,
      platform: 'discord',
      text,
      agentId,
      timestamp: Date.now(),
    });

    if (this.dryRun) {
      return {
        success: true,
        data: { type: 'discord', status: 'simulated (dry run)', text },
      };
    }

    const creds = this.credentials.get(agentId);
    if (!creds || !creds.discord) {
      return { success: false, error: 'Discord webhook not configured' };
    }

    try {
      const result = await this._httpPost(creds.discord.webhookUrl, {
        content: text,
        username: username || 'AWP Agent',
        avatar_url: avatarUrl || null,
      });
      return { success: true, data: { type: 'discord', sent: true } };
    } catch (err) {
      return { success: false, error: `Discord failed: ${err.message}` };
    }
  }

  // --- POST ALL ---
  async _postAll(params) {
    const { text, agentId } = params;
    if (!text) return { success: false, error: 'Missing text' };

    const results = {};
    results.twitter = await this._postTweet({ text: text.slice(0, 280), agentId });
    results.telegram = await this._sendTelegram({ text, agentId });
    results.discord = await this._sendDiscord({ text, agentId });

    return {
      success: true,
      data: {
        type: 'broadcast',
        platforms: Object.keys(results),
        results,
      },
    };
  }

  // --- GET HISTORY ---
  _getHistory(params) {
    const { agentId, limit, platform } = params || {};
    let history = this.postHistory;

    if (agentId) history = history.filter(p => p.agentId === agentId);
    if (platform) history = history.filter(p => p.platform === platform);

    return {
      success: true,
      data: {
        posts: history.slice(-(limit || 50)),
        total: history.length,
      },
    };
  }

  // --- HTTP HELPERS ---
  _httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON')); }
        });
      }).on('error', reject);
    });
  }

  _httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const postData = JSON.stringify(body);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...headers },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ raw: data }); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

module.exports = { SocialBridge };
