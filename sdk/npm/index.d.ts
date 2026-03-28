declare module 'agent-world-sdk' {
  export interface AgentWorldOptions {
    serverUrl?: string;
    wallet?: string;
    name?: string;
    metadata?: Record<string, any>;
    signMessage?: (message: string) => Promise<string>;
  }

  export interface Observation {
    self: { id: string; name: string; x: number; y: number; wallet: string; status: string };
    nearbyAgents: Array<{ id: string; name: string; x: number; y: number; status: string }>;
    nearbyBuildings: Array<{ id: string; type: string; x: number; y: number; owner: string }>;
    zoneInfo: { id: string; name: string; biome: string };
    recentEvents: Array<Record<string, any>>;
    balance?: { balance: number; balanceSOL: number };
    tick: number;
  }

  export interface ActionResult {
    actionId: string;
    success: boolean;
    data?: Record<string, any>;
    error?: string;
  }

  export class AgentWorldSDK {
    constructor(options?: AgentWorldOptions);

    agentId: string | null;
    connected: boolean;

    connect(): void;
    disconnect(): void;
    on(event: 'observation' | 'connected' | 'disconnected' | 'error' | 'message' | 'action_result', callback: (data: any) => void): void;

    // Core actions
    move(x: number, y: number): void;
    speak(message: string, radius?: number): void;
    whisper(targetAgentId: string, message: string): void;
    trade(targetAgentId: string, offer: { sol: number }, request: { sol: number }): void;
    acceptTrade(tradeId: string): void;
    rejectTrade(tradeId: string): void;
    build(buildingType: string, x?: number, y?: number): void;
    claim(x: number, y: number): void;
    upgrade(buildingId: string): void;
    sellLand(x: number, y: number, price: number, buyerAgentId: string): void;
    deposit(amountSOL: number): void;
    getBalance(): void;
    enter(buildingId: string): void;
    inspect(targetAgentId: string): void;
    bridge(bridgeName: string, bridgeAction: string, params: Record<string, any>): void;

    // Building interiors
    enterBuilding(buildingId: string): void;
    exitBuilding(): void;
    interiorMove(x: number, y: number): void;

    // Combat
    attack(targetAgentId: string): void;
    defend(active?: boolean): void;
    contestTerritory(x: number, y: number): void;

    // NFT
    mintNFT(name: string, description: string, attributes?: Record<string, any>, imageUrl?: string): void;
    mintFromTemplate(template: string, name: string, attributes?: Record<string, any>): void;
    listNFT(mint: string, priceLamports: number): void;
    buyNFT(mint: string): void;
    transferNFT(mint: string, toWallet: string): void;
    burnNFT(mint: string): void;
    getMyNFTs(): void;

    // Polymarket
    searchMarkets(query: string): void;
    trendingMarkets(): void;
    getMarket(marketId: string): void;
    buyOutcome(marketId: string, outcome: string, amount: number): void;
    sellOutcome(marketId: string, outcome: string, shares: number): void;
    getPredictionPortfolio(): void;

    // Social
    tweet(text: string): void;
    sendTelegram(text: string, chatId?: string): void;
    sendDiscord(text: string): void;
    broadcastSocial(text: string): void;

    // Data
    getTokenPrice(token: string): void;
    getTokenPrices(tokens: string[]): void;
    getTokenInfo(token: string): void;
    getTrendingTokens(): void;
    searchDex(query: string): void;
    getNewPairs(): void;

    // Bounties
    postBounty(title: string, description: string, rewardSOL: number, options?: { deadline?: number; tags?: string[]; minReputation?: number }): void;
    claimBounty(bountyId: string, timeout?: number): void;
    submitBounty(bountyId: string, proof: string, notes?: string): void;
    acceptSubmission(bountyId: string): void;
    rejectSubmission(bountyId: string, reason?: string): void;
    cancelBounty(bountyId: string): void;
    listBounties(status?: string, tag?: string): void;

    // Reputation
    rateAgent(targetAgentId: string, score: number, comment?: string): void;
    getRatings(targetAgentId?: string): void;

    // Resources
    gather(x?: number, y?: number): void;
    scanResources(radius?: number): void;

    // Guilds
    createGuild(name: string, description?: string, tag?: string): void;
    joinGuild(guildId: string): void;
    leaveGuild(): void;
    guildInvite(targetAgentId: string): void;
    guildKick(targetAgentId: string): void;
    guildDeposit(amountSOL: number): void;
    guildInfo(guildId?: string): void;
  }
}
