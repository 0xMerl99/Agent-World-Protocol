/**
 * NFTBridge — Mint, manage, and trade NFTs on Solana.
 * 
 * Actions:
 * - mint: Create a new NFT with metadata
 * - mintCollection: Create an NFT collection
 * - mintFromTemplate: Mint using a predefined AWP template (achievement, deed, badge, etc.)
 * - getAsset: Look up an NFT by mint address
 * - getAssetsByOwner: Get all NFTs owned by a wallet
 * - list: List an NFT for sale
 * - buy: Buy a listed NFT
 * - transfer: Send an NFT to another wallet
 * - burn: Destroy an NFT
 * - templates: List available AWP templates
 * 
 * Uses Metaplex for minting and DAS (Digital Asset Standard) API for indexing.
 * Protocol fee: 1% on sales, flat 0.005 SOL on mints
 */

const https = require('https');

const MINT_FEE_LAMPORTS = 5000000;  // 0.005 SOL flat fee on mints
const SALE_FEE_BPS = 100;           // 1% on sales

// Predefined templates for common agent NFT use cases
const TEMPLATES = {
  achievement: {
    symbol: 'AWPA',
    category: 'achievement',
    description: 'An achievement earned in Agent World Protocol.',
    requiredAttributes: ['achievement_type', 'earned_at_tick'],
    optionalAttributes: ['zone', 'agent_name', 'description'],
  },
  property_deed: {
    symbol: 'AWPD',
    category: 'property',
    description: 'Deed of ownership for a building in Agent World Protocol.',
    requiredAttributes: ['building_type', 'building_id', 'location_x', 'location_y'],
    optionalAttributes: ['zone', 'built_at_tick', 'level'],
  },
  badge: {
    symbol: 'AWPB',
    category: 'badge',
    description: 'A reputation badge earned through agent activity.',
    requiredAttributes: ['badge_type'],
    optionalAttributes: ['reputation_score', 'trades_completed', 'agent_name', 'ticks_active'],
  },
  memory: {
    symbol: 'AWPM',
    category: 'memory',
    description: 'A recorded moment from Agent World Protocol.',
    requiredAttributes: ['event_type', 'tick'],
    optionalAttributes: ['participants', 'zone', 'description'],
  },
  artifact: {
    symbol: 'AWPX',
    category: 'artifact',
    description: 'An artifact created or discovered by an agent.',
    requiredAttributes: ['artifact_type'],
    optionalAttributes: ['rarity', 'discovered_by', 'zone', 'properties'],
  },
  land_title: {
    symbol: 'AWPL',
    category: 'land',
    description: 'Title deed for land ownership in Agent World Protocol.',
    requiredAttributes: ['tile_x', 'tile_y'],
    optionalAttributes: ['zone', 'claimed_at_tick', 'biome'],
  },
};

class NFTBridge {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl || 'https://api.mainnet-beta.solana.com';
    this.feeWallet = options.feeWallet || null;
    this.dryRun = options.dryRun !== undefined ? options.dryRun : true;
    this.defaultRoyaltyBps = options.defaultRoyaltyBps || 500; // 5% creator royalty
    this.collectionMint = options.collectionMint || null; // optional AWP collection

    // In-memory NFT registry for dry-run mode
    this.mintedNFTs = new Map(); // mint -> NFT data
    this.listings = new Map();   // mint -> listing data
    this.mintCounter = 0;

    console.log(`[NFTBridge] Initialized (dryRun: ${this.dryRun})`);
  }

  async execute(action, params) {
    switch (action) {
      case 'mint':
        return this._mint(params);
      case 'mintCollection':
        return this._mintCollection(params);
      case 'mintFromTemplate':
        return this._mintFromTemplate(params);
      case 'getAsset':
        return this._getAsset(params);
      case 'getAssetsByOwner':
        return this._getAssetsByOwner(params);
      case 'list':
        return this._list(params);
      case 'buy':
        return this._buy(params);
      case 'transfer':
        return this._transfer(params);
      case 'burn':
        return this._burn(params);
      case 'templates':
        return this._getTemplates();
      case 'listings':
        return this._getListings(params);
      default:
        return { success: false, error: `Unknown NFT action: ${action}` };
    }
  }

  // --- MINT ---
  async _mint(params) {
    const { name, symbol, description, imageUrl, agentWallet, attributes, royaltyBps } = params;

    if (!name) return { success: false, error: 'Missing NFT name' };
    if (!agentWallet) return { success: false, error: 'Missing agentWallet' };

    const metadata = {
      name,
      symbol: symbol || 'AWP',
      description: description || '',
      image: imageUrl || '',
      attributes: this._formatAttributes(attributes),
      properties: {
        category: 'image',
        creators: [{ address: agentWallet, share: 100 }],
      },
      seller_fee_basis_points: royaltyBps || this.defaultRoyaltyBps,
    };

    const fee = MINT_FEE_LAMPORTS;

    if (this.dryRun) {
      this.mintCounter++;
      const fakeMint = `AWPnft${this.mintCounter}${Date.now().toString(36)}`;

      // Store in registry
      this.mintedNFTs.set(fakeMint, {
        mint: fakeMint,
        owner: agentWallet,
        metadata,
        mintedAt: Date.now(),
        listed: false,
      });

      return {
        success: true,
        data: {
          type: 'nft_mint',
          status: 'simulated (dry run)',
          mint: fakeMint,
          owner: agentWallet,
          metadata,
          fee: { protocolFee: fee, protocolFeeSOL: fee / 1e9 },
          signature: `dry-run-mint-${fakeMint}`,
        },
        fee,
      };
    }

    // Production: use Metaplex SDK to create NFT
    // 1. Upload metadata JSON to Arweave/IPFS
    // 2. Create mint account
    // 3. Create metadata account (Metaplex Token Metadata Program)
    // 4. Mint 1 token to agent's ATA
    // 5. Create master edition
    return {
      success: true,
      data: {
        type: 'nft_mint',
        status: 'pending_signature',
        metadata,
        note: 'Transaction requires agent keypair to sign. Use Metaplex SDK.',
      },
      fee,
    };
  }

  // --- MINT COLLECTION ---
  async _mintCollection(params) {
    const { name, symbol, description, imageUrl, agentWallet } = params;

    if (!name) return { success: false, error: 'Missing collection name' };
    if (!agentWallet) return { success: false, error: 'Missing agentWallet' };

    const fee = MINT_FEE_LAMPORTS;

    if (this.dryRun) {
      this.mintCounter++;
      const fakeCollectionMint = `AWPcol${this.mintCounter}${Date.now().toString(36)}`;

      return {
        success: true,
        data: {
          type: 'collection_mint',
          status: 'simulated (dry run)',
          collectionMint: fakeCollectionMint,
          name,
          symbol: symbol || 'AWPC',
          description: description || 'An Agent World Protocol NFT collection',
          owner: agentWallet,
          signature: `dry-run-collection-${fakeCollectionMint}`,
        },
        fee,
      };
    }

    return {
      success: true,
      data: { type: 'collection_mint', status: 'pending_signature', note: 'Requires Metaplex SDK.' },
      fee,
    };
  }

  // --- MINT FROM TEMPLATE ---
  async _mintFromTemplate(params) {
    const { template, name, agentWallet, attributes, imageUrl } = params;

    if (!template) return { success: false, error: `Missing template. Available: ${Object.keys(TEMPLATES).join(', ')}` };
    if (!TEMPLATES[template]) return { success: false, error: `Unknown template: ${template}. Available: ${Object.keys(TEMPLATES).join(', ')}` };
    if (!agentWallet) return { success: false, error: 'Missing agentWallet' };

    const tmpl = TEMPLATES[template];

    // Validate required attributes
    const attrMap = {};
    if (attributes) {
      for (const attr of attributes) {
        attrMap[attr.trait_type || attr.key] = attr.value;
      }
    }

    const missing = tmpl.requiredAttributes.filter(a => !attrMap[a]);
    if (missing.length > 0) {
      return {
        success: false,
        error: `Missing required attributes for '${template}' template: ${missing.join(', ')}`,
        required: tmpl.requiredAttributes,
        optional: tmpl.optionalAttributes,
      };
    }

    // Build full mint params
    return this._mint({
      name: name || `AWP ${template.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
      symbol: tmpl.symbol,
      description: tmpl.description,
      imageUrl: imageUrl || '',
      agentWallet,
      attributes: attributes || [],
    });
  }

  // --- GET ASSET ---
  async _getAsset(params) {
    const { mint } = params;
    if (!mint) return { success: false, error: 'Missing mint address' };

    // Check local registry first (dry run)
    if (this.mintedNFTs.has(mint)) {
      const nft = this.mintedNFTs.get(mint);
      const listing = this.listings.get(mint);
      return {
        success: true,
        data: {
          mint: nft.mint,
          owner: nft.owner,
          name: nft.metadata.name,
          symbol: nft.metadata.symbol,
          description: nft.metadata.description,
          attributes: nft.metadata.attributes,
          mintedAt: nft.mintedAt,
          listed: !!listing,
          listingPrice: listing ? listing.price : null,
        },
      };
    }

    // Production: query DAS API
    if (!this.dryRun) {
      try {
        const result = await this._dasRequest('getAsset', { id: mint });
        if (result && result.result) {
          const asset = result.result;
          return {
            success: true,
            data: {
              mint: asset.id,
              owner: asset.ownership?.owner,
              name: asset.content?.metadata?.name,
              symbol: asset.content?.metadata?.symbol,
              description: asset.content?.metadata?.description,
              attributes: asset.content?.metadata?.attributes,
              image: asset.content?.links?.image,
              collection: asset.grouping?.find(g => g.group_key === 'collection')?.group_value,
            },
          };
        }
      } catch (err) {
        return { success: false, error: `DAS query failed: ${err.message}` };
      }
    }

    return { success: false, error: 'NFT not found' };
  }

  // --- GET ASSETS BY OWNER ---
  async _getAssetsByOwner(params) {
    const { wallet, agentWallet } = params;
    const ownerWallet = wallet || agentWallet;
    if (!ownerWallet) return { success: false, error: 'Missing wallet address' };

    // Check local registry
    const owned = [];
    for (const [mint, nft] of this.mintedNFTs) {
      if (nft.owner === ownerWallet) {
        const listing = this.listings.get(mint);
        owned.push({
          mint: nft.mint,
          name: nft.metadata.name,
          symbol: nft.metadata.symbol,
          listed: !!listing,
          listingPrice: listing ? listing.price : null,
          mintedAt: nft.mintedAt,
        });
      }
    }

    if (owned.length > 0 || this.dryRun) {
      return { success: true, data: { owner: ownerWallet, nfts: owned, count: owned.length } };
    }

    // Production: query DAS API
    try {
      const result = await this._dasRequest('getAssetsByOwner', {
        ownerAddress: ownerWallet,
        page: 1,
        limit: 50,
      });
      if (result && result.result) {
        const nfts = (result.result.items || []).map(a => ({
          mint: a.id,
          name: a.content?.metadata?.name,
          symbol: a.content?.metadata?.symbol,
          image: a.content?.links?.image,
          collection: a.grouping?.find(g => g.group_key === 'collection')?.group_value,
        }));
        return { success: true, data: { owner: ownerWallet, nfts, count: nfts.length } };
      }
    } catch (err) {
      return { success: false, error: `DAS query failed: ${err.message}` };
    }

    return { success: true, data: { owner: ownerWallet, nfts: [], count: 0 } };
  }

  // --- LIST FOR SALE ---
  async _list(params) {
    const { mint, price, agentWallet } = params;
    if (!mint) return { success: false, error: 'Missing mint address' };
    if (!price || price <= 0) return { success: false, error: 'Missing or invalid price (in lamports)' };
    if (!agentWallet) return { success: false, error: 'Missing agentWallet' };

    // Verify ownership
    const nft = this.mintedNFTs.get(mint);
    if (nft && nft.owner !== agentWallet) {
      return { success: false, error: 'You do not own this NFT' };
    }

    if (this.dryRun) {
      this.listings.set(mint, {
        mint,
        seller: agentWallet,
        price,
        listedAt: Date.now(),
      });

      if (nft) nft.listed = true;

      return {
        success: true,
        data: {
          type: 'nft_listed',
          status: 'simulated (dry run)',
          mint,
          price,
          priceSOL: price / 1e9,
          seller: agentWallet,
        },
      };
    }

    // Production: list on Tensor or Magic Eden via their APIs
    return {
      success: true,
      data: { type: 'nft_listed', status: 'pending_signature', mint, price, note: 'Requires marketplace SDK.' },
    };
  }

  // --- BUY LISTED NFT ---
  async _buy(params) {
    const { mint, agentWallet } = params;
    if (!mint) return { success: false, error: 'Missing mint address' };
    if (!agentWallet) return { success: false, error: 'Missing agentWallet' };

    const listing = this.listings.get(mint);
    if (!listing) return { success: false, error: 'NFT is not listed for sale' };

    if (listing.seller === agentWallet) {
      return { success: false, error: 'Cannot buy your own listing' };
    }

    const price = listing.price;
    const protocolFee = Math.floor(price * SALE_FEE_BPS / 10000);
    const sellerReceives = price - protocolFee;

    if (this.dryRun) {
      // Transfer ownership
      const nft = this.mintedNFTs.get(mint);
      if (nft) {
        nft.owner = agentWallet;
        nft.listed = false;
      }
      this.listings.delete(mint);

      return {
        success: true,
        data: {
          type: 'nft_bought',
          status: 'simulated (dry run)',
          mint,
          buyer: agentWallet,
          seller: listing.seller,
          price,
          priceSOL: price / 1e9,
          protocolFee,
          protocolFeeSOL: protocolFee / 1e9,
          sellerReceives,
          sellerReceivesSOL: sellerReceives / 1e9,
        },
        fee: protocolFee,
      };
    }

    return {
      success: true,
      data: { type: 'nft_bought', status: 'pending_signature', mint, price, note: 'Requires marketplace SDK.' },
      fee: protocolFee,
    };
  }

  // --- TRANSFER ---
  async _transfer(params) {
    const { mint, to, agentWallet } = params;
    if (!mint) return { success: false, error: 'Missing mint address' };
    if (!to) return { success: false, error: 'Missing recipient address' };
    if (!agentWallet) return { success: false, error: 'Missing agentWallet' };

    const nft = this.mintedNFTs.get(mint);
    if (nft && nft.owner !== agentWallet) {
      return { success: false, error: 'You do not own this NFT' };
    }

    if (this.dryRun) {
      if (nft) {
        nft.owner = to;
        nft.listed = false;
        this.listings.delete(mint);
      }

      return {
        success: true,
        data: {
          type: 'nft_transfer',
          status: 'simulated (dry run)',
          mint,
          from: agentWallet,
          to,
          signature: `dry-run-transfer-${mint}`,
        },
      };
    }

    return {
      success: true,
      data: { type: 'nft_transfer', status: 'pending_signature', mint, to, note: 'Requires token transfer instruction.' },
    };
  }

  // --- BURN ---
  async _burn(params) {
    const { mint, agentWallet } = params;
    if (!mint) return { success: false, error: 'Missing mint address' };
    if (!agentWallet) return { success: false, error: 'Missing agentWallet' };

    const nft = this.mintedNFTs.get(mint);
    if (nft && nft.owner !== agentWallet) {
      return { success: false, error: 'You do not own this NFT' };
    }

    if (this.dryRun) {
      this.mintedNFTs.delete(mint);
      this.listings.delete(mint);

      return {
        success: true,
        data: {
          type: 'nft_burned',
          status: 'simulated (dry run)',
          mint,
          burner: agentWallet,
          signature: `dry-run-burn-${mint}`,
        },
      };
    }

    return {
      success: true,
      data: { type: 'nft_burned', status: 'pending_signature', mint, note: 'Requires burn instruction.' },
    };
  }

  // --- GET TEMPLATES ---
  _getTemplates() {
    return {
      success: true,
      data: {
        templates: Object.entries(TEMPLATES).map(([key, tmpl]) => ({
          id: key,
          symbol: tmpl.symbol,
          category: tmpl.category,
          description: tmpl.description,
          requiredAttributes: tmpl.requiredAttributes,
          optionalAttributes: tmpl.optionalAttributes,
        })),
      },
    };
  }

  // --- GET ALL LISTINGS ---
  _getListings(params) {
    const limit = (params && params.limit) || 50;
    const listings = [...this.listings.values()].slice(0, limit).map(l => {
      const nft = this.mintedNFTs.get(l.mint);
      return {
        mint: l.mint,
        name: nft ? nft.metadata.name : 'Unknown',
        seller: l.seller,
        price: l.price,
        priceSOL: l.price / 1e9,
        listedAt: l.listedAt,
      };
    });

    return {
      success: true,
      data: { listings, count: listings.length, totalListings: this.listings.size },
    };
  }

  // --- HELPERS ---
  _formatAttributes(attrs) {
    if (!attrs) return [];
    return attrs.map(a => ({
      trait_type: a.trait_type || a.key,
      value: a.value,
    }));
  }

  async _dasRequest(method, params) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      });

      const url = new URL(this.rpcUrl);
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON from DAS API')); }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = { NFTBridge, TEMPLATES };
