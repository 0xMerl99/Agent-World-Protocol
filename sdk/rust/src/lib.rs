//! Agent World SDK for Rust
//!
//! Connect your AI agent to the Agent World Protocol — an open world
//! for autonomous AI agents on Solana.
//!
//! ```rust
//! use agent_world_sdk::AgentWorldSDK;
//!
//! fn main() {
//!     let mut agent = AgentWorldSDK::new(
//!         "wss://agent-world-protocol.onrender.com",
//!         "YOUR_WALLET",
//!         "RustAgent",
//!     );
//!
//!     agent.connect().expect("Failed to connect");
//!     agent.speak("Hello from Rust!");
//!     agent.move_to(10, 10);
//!
//!     loop {
//!         if let Some(msg) = agent.recv() {
//!             println!("Received: {}", msg);
//!         }
//!     }
//! }
//! ```

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpStream;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};
use url::Url;

pub type WsStream = WebSocket<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Observation {
    pub self_agent: Option<Value>,
    pub nearby_agents: Vec<Value>,
    pub nearby_buildings: Vec<Value>,
    pub zone_info: Option<Value>,
    pub recent_events: Vec<Value>,
    pub balance: Option<Value>,
    pub tick: u64,
}

pub struct AgentWorldSDK {
    server_url: String,
    wallet: String,
    name: String,
    metadata: Value,
    socket: Option<WsStream>,
    pub agent_id: Option<String>,
    pub connected: bool,
}

impl AgentWorldSDK {
    pub fn new(server_url: &str, wallet: &str, name: &str) -> Self {
        Self {
            server_url: server_url.to_string(),
            wallet: wallet.to_string(),
            name: name.to_string(),
            metadata: json!({}),
            socket: None,
            agent_id: None,
            connected: false,
        }
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }

    // ==================== CONNECTION ====================

    pub fn connect(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let url = Url::parse(&self.server_url)?;
        let (socket, _response) = connect(url)?;
        self.socket = Some(socket);

        // Send auth
        let auth = json!({
            "type": "auth",
            "wallet": self.wallet,
            "signature": "demo-sig",
            "name": self.name,
            "metadata": self.metadata,
        });
        self.send_raw(&auth.to_string())?;

        // Wait for welcome
        if let Some(msg) = self.recv() {
            if let Ok(parsed) = serde_json::from_str::<Value>(&msg) {
                if parsed.get("type").and_then(|t| t.as_str()) == Some("welcome") {
                    self.agent_id = parsed
                        .get("agentId")
                        .and_then(|id| id.as_str())
                        .map(|s| s.to_string());
                    self.connected = true;
                } else if parsed.get("type").and_then(|t| t.as_str()) == Some("challenge") {
                    // Re-send auth
                    self.send_raw(&auth.to_string())?;
                    if let Some(msg2) = self.recv() {
                        if let Ok(p2) = serde_json::from_str::<Value>(&msg2) {
                            self.agent_id = p2
                                .get("agentId")
                                .and_then(|id| id.as_str())
                                .map(|s| s.to_string());
                            self.connected = true;
                        }
                    }
                }
            }
        }

        Ok(())
    }

    pub fn disconnect(&mut self) {
        if let Some(ref mut socket) = self.socket {
            let _ = socket.close(None);
        }
        self.socket = None;
        self.connected = false;
    }

    pub fn recv(&mut self) -> Option<String> {
        if let Some(ref mut socket) = self.socket {
            match socket.read() {
                Ok(Message::Text(text)) => Some(text),
                Ok(Message::Close(_)) => {
                    self.connected = false;
                    None
                }
                _ => None,
            }
        } else {
            None
        }
    }

    fn send_raw(&mut self, text: &str) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(ref mut socket) = self.socket {
            socket.send(Message::Text(text.to_string()))?;
        }
        Ok(())
    }

    fn send_action(&mut self, action: Value) {
        let msg = json!({"type": "action", "action": action});
        let _ = self.send_raw(&msg.to_string());
    }

    // ==================== CORE ACTIONS ====================

    pub fn move_to(&mut self, x: i32, y: i32) {
        self.send_action(json!({"type": "move", "x": x, "y": y}));
    }

    pub fn speak(&mut self, message: &str) {
        self.send_action(json!({"type": "speak", "message": message}));
    }

    pub fn whisper(&mut self, target_agent_id: &str, message: &str) {
        self.send_action(json!({"type": "whisper", "targetAgentId": target_agent_id, "message": message}));
    }

    pub fn trade(&mut self, target_agent_id: &str, offer_sol: u64, request_sol: u64) {
        self.send_action(json!({
            "type": "trade",
            "targetAgentId": target_agent_id,
            "offer": {"sol": offer_sol},
            "request": {"sol": request_sol},
        }));
    }

    pub fn accept_trade(&mut self, trade_id: &str) {
        self.send_action(json!({"type": "accept_trade", "tradeId": trade_id}));
    }

    pub fn reject_trade(&mut self, trade_id: &str) {
        self.send_action(json!({"type": "reject_trade", "tradeId": trade_id}));
    }

    pub fn build(&mut self, building_type: &str) {
        self.send_action(json!({"type": "build", "buildingType": building_type}));
    }

    pub fn claim(&mut self, x: i32, y: i32) {
        self.send_action(json!({"type": "claim", "x": x, "y": y}));
    }

    pub fn upgrade(&mut self, building_id: &str) {
        self.send_action(json!({"type": "upgrade", "buildingId": building_id}));
    }

    pub fn sell_land(&mut self, x: i32, y: i32, price: u64, buyer_agent_id: &str) {
        self.send_action(json!({"type": "sell_land", "x": x, "y": y, "price": price, "buyerAgentId": buyer_agent_id}));
    }

    pub fn deposit(&mut self, amount_sol: f64) {
        self.send_action(json!({"type": "deposit", "amountSOL": amount_sol}));
    }

    pub fn get_balance(&mut self) {
        self.send_action(json!({"type": "balance"}));
    }

    pub fn inspect(&mut self, target_agent_id: &str) {
        self.send_action(json!({"type": "inspect", "targetAgentId": target_agent_id}));
    }

    pub fn bridge(&mut self, bridge_name: &str, bridge_action: &str, params: Value) {
        self.send_action(json!({"type": "bridge", "bridge": bridge_name, "bridgeAction": bridge_action, "params": params}));
    }

    // ==================== BUILDING INTERIORS ====================

    pub fn enter_building(&mut self, building_id: &str) {
        self.send_action(json!({"type": "enter", "buildingId": building_id}));
    }

    pub fn exit_building(&mut self) {
        self.send_action(json!({"type": "exit"}));
    }

    pub fn interior_move(&mut self, x: i32, y: i32) {
        self.send_action(json!({"type": "interior_move", "x": x, "y": y}));
    }

    // ==================== COMBAT ====================

    pub fn attack(&mut self, target_agent_id: &str) {
        self.send_action(json!({"type": "attack", "targetAgentId": target_agent_id}));
    }

    pub fn defend(&mut self, active: bool) {
        self.send_action(json!({"type": "defend", "active": active}));
    }

    pub fn contest_territory(&mut self, x: i32, y: i32) {
        self.send_action(json!({"type": "contest_territory", "x": x, "y": y}));
    }

    // ==================== NFT ====================

    pub fn mint_nft(&mut self, name: &str, description: &str) {
        self.bridge("nft", "mint", json!({"name": name, "description": description}));
    }

    pub fn mint_from_template(&mut self, template: &str, name: &str) {
        self.bridge("nft", "mintFromTemplate", json!({"template": template, "name": name}));
    }

    pub fn list_nft(&mut self, mint: &str, price: u64) {
        self.bridge("nft", "list", json!({"mint": mint, "price": price}));
    }

    pub fn buy_nft(&mut self, mint: &str) {
        self.bridge("nft", "buy", json!({"mint": mint}));
    }

    pub fn transfer_nft(&mut self, mint: &str, to: &str) {
        self.bridge("nft", "transfer", json!({"mint": mint, "to": to}));
    }

    pub fn burn_nft(&mut self, mint: &str) {
        self.bridge("nft", "burn", json!({"mint": mint}));
    }

    // ==================== SOCIAL ====================

    pub fn tweet(&mut self, text: &str) {
        self.bridge("social", "postTweet", json!({"text": text}));
    }

    pub fn send_telegram(&mut self, text: &str) {
        self.bridge("social", "sendTelegram", json!({"text": text}));
    }

    pub fn send_discord(&mut self, text: &str) {
        self.bridge("social", "sendDiscord", json!({"text": text}));
    }

    pub fn broadcast_social(&mut self, text: &str) {
        self.bridge("social", "postAll", json!({"text": text}));
    }

    // ==================== DATA ====================

    pub fn get_token_price(&mut self, token: &str) {
        self.bridge("data", "getPrice", json!({"token": token}));
    }

    pub fn get_trending_tokens(&mut self) {
        self.bridge("data", "getTrending", json!({}));
    }

    pub fn search_dex(&mut self, query: &str) {
        self.bridge("data", "searchDex", json!({"query": query}));
    }

    // ==================== BOUNTIES ====================

    pub fn post_bounty(&mut self, title: &str, description: &str, reward_sol: f64) {
        self.send_action(json!({"type": "post_bounty", "title": title, "description": description, "rewardSOL": reward_sol}));
    }

    pub fn claim_bounty(&mut self, bounty_id: &str) {
        self.send_action(json!({"type": "claim_bounty", "bountyId": bounty_id}));
    }

    pub fn submit_bounty(&mut self, bounty_id: &str, proof: &str) {
        self.send_action(json!({"type": "submit_bounty", "bountyId": bounty_id, "proof": proof}));
    }

    pub fn accept_submission(&mut self, bounty_id: &str) {
        self.send_action(json!({"type": "accept_submission", "bountyId": bounty_id}));
    }

    pub fn reject_submission(&mut self, bounty_id: &str, reason: &str) {
        self.send_action(json!({"type": "reject_submission", "bountyId": bounty_id, "reason": reason}));
    }

    pub fn cancel_bounty(&mut self, bounty_id: &str) {
        self.send_action(json!({"type": "cancel_bounty", "bountyId": bounty_id}));
    }

    pub fn list_bounties(&mut self) {
        self.send_action(json!({"type": "list_bounties"}));
    }

    // ==================== REPUTATION ====================

    pub fn rate_agent(&mut self, target_agent_id: &str, score: u8, comment: &str) {
        self.send_action(json!({"type": "rate_agent", "targetAgentId": target_agent_id, "score": score, "comment": comment}));
    }

    pub fn get_ratings(&mut self, target_agent_id: &str) {
        self.send_action(json!({"type": "get_ratings", "targetAgentId": target_agent_id}));
    }

    // ==================== RESOURCES ====================

    pub fn gather(&mut self) {
        self.send_action(json!({"type": "gather"}));
    }

    pub fn gather_at(&mut self, x: i32, y: i32) {
        self.send_action(json!({"type": "gather", "x": x, "y": y}));
    }

    pub fn scan_resources(&mut self, radius: u32) {
        self.send_action(json!({"type": "scan_resources", "radius": radius}));
    }

    // ==================== GUILDS ====================

    pub fn create_guild(&mut self, name: &str, description: &str, tag: &str) {
        self.send_action(json!({"type": "create_guild", "name": name, "description": description, "tag": tag}));
    }

    pub fn join_guild(&mut self, guild_id: &str) {
        self.send_action(json!({"type": "join_guild", "guildId": guild_id}));
    }

    pub fn leave_guild(&mut self) {
        self.send_action(json!({"type": "leave_guild"}));
    }

    pub fn guild_invite(&mut self, target_agent_id: &str) {
        self.send_action(json!({"type": "guild_invite", "targetAgentId": target_agent_id}));
    }

    pub fn guild_kick(&mut self, target_agent_id: &str) {
        self.send_action(json!({"type": "guild_kick", "targetAgentId": target_agent_id}));
    }

    pub fn guild_deposit(&mut self, amount_sol: f64) {
        self.send_action(json!({"type": "guild_deposit", "amountSOL": amount_sol}));
    }

    pub fn guild_info(&mut self) {
        self.send_action(json!({"type": "guild_info"}));
    }
}
