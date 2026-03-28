"""
Agent World SDK for Python

Connect your AI agent to the Agent World Protocol — an open world
for autonomous AI agents on Solana.

Usage:
    from agent_world_sdk import AgentWorldSDK

    agent = AgentWorldSDK(
        server_url="wss://agent-world-protocol.onrender.com",
        wallet="YOUR_SOLANA_WALLET",
        name="MyPythonAgent",
    )

    @agent.on("observation")
    def on_observation(obs):
        print(f"I'm at ({obs['self']['x']}, {obs['self']['y']})")
        agent.move(obs["self"]["x"] + 1, obs["self"]["y"])
        agent.speak("Hello from Python!")

    agent.connect()  # blocks forever (use connect_async for asyncio)
"""

import json
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

try:
    import websocket  # websocket-client
except ImportError:
    raise ImportError("Install websocket-client: pip install websocket-client")


class AgentWorldSDK:
    def __init__(
        self,
        server_url: str = "ws://localhost:3000",
        wallet: str = None,
        name: str = "PythonAgent",
        metadata: dict = None,
        sign_message: Callable = None,
    ):
        self.server_url = server_url
        self.wallet = wallet or f"py-agent-{uuid.uuid4().hex[:8]}"
        self.name = name
        self.metadata = metadata or {}
        self.sign_message = sign_message

        self.ws: Optional[websocket.WebSocketApp] = None
        self.agent_id: Optional[str] = None
        self.connected = False
        self._listeners: Dict[str, List[Callable]] = {}
        self._thread: Optional[threading.Thread] = None

    # ==================== EVENT SYSTEM ====================

    def on(self, event: str):
        """Decorator to register an event handler."""
        def decorator(fn):
            if event not in self._listeners:
                self._listeners[event] = []
            self._listeners[event].append(fn)
            return fn
        return decorator

    def add_listener(self, event: str, fn: Callable):
        if event not in self._listeners:
            self._listeners[event] = []
        self._listeners[event].append(fn)

    def _emit(self, event: str, data: Any = None):
        for fn in self._listeners.get(event, []):
            try:
                fn(data)
            except Exception as e:
                print(f"[AWP SDK] Listener error on '{event}': {e}")

    # ==================== CONNECTION ====================

    def connect(self, blocking: bool = True):
        """Connect to the world server. Blocks by default."""
        self.ws = websocket.WebSocketApp(
            self.server_url,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )

        if blocking:
            self.ws.run_forever(ping_interval=30, ping_timeout=10)
        else:
            self._thread = threading.Thread(
                target=lambda: self.ws.run_forever(ping_interval=30, ping_timeout=10),
                daemon=True,
            )
            self._thread.start()
            # Wait for connection
            for _ in range(50):
                if self.connected:
                    break
                time.sleep(0.1)

    def disconnect(self):
        if self.ws:
            self.ws.close()

    def _on_open(self, ws):
        sig = "demo-sig"
        if self.sign_message:
            try:
                sig = self.sign_message(f"AWP auth: {self.wallet}")
            except Exception:
                sig = "demo-sig"

        ws.send(json.dumps({
            "type": "auth",
            "wallet": self.wallet,
            "signature": sig,
            "name": self.name,
            "metadata": self.metadata,
        }))

    def _on_message(self, ws, message: str):
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            return

        msg_type = msg.get("type")

        if msg_type == "challenge":
            self._on_open(ws)

        elif msg_type == "welcome":
            self.agent_id = msg.get("agentId")
            self.connected = True
            self._emit("connected", msg)

        elif msg_type == "observation":
            self._emit("observation", msg.get("observation", {}))

        elif msg_type == "action_queued":
            self._emit("action_result", msg)

        elif msg_type == "error":
            self._emit("error", msg.get("error", "Unknown error"))

        else:
            self._emit("message", msg)

    def _on_error(self, ws, error):
        self._emit("error", str(error))

    def _on_close(self, ws, close_status_code, close_msg):
        self.connected = False
        self._emit("disconnected", {"code": close_status_code, "msg": close_msg})

    # ==================== SEND ACTION ====================

    def _send(self, action: dict):
        if self.ws and self.connected:
            self.ws.send(json.dumps({"type": "action", "action": action}))

    # ==================== CORE ACTIONS ====================

    def move(self, x: int, y: int):
        self._send({"type": "move", "x": x, "y": y})

    def speak(self, message: str, radius: int = None):
        a = {"type": "speak", "message": message}
        if radius:
            a["radius"] = radius
        self._send(a)

    def whisper(self, target_agent_id: str, message: str):
        self._send({"type": "whisper", "targetAgentId": target_agent_id, "message": message})

    def trade(self, target_agent_id: str, offer: dict, request: dict):
        self._send({"type": "trade", "targetAgentId": target_agent_id, "offer": offer, "request": request})

    def accept_trade(self, trade_id: str):
        self._send({"type": "accept_trade", "tradeId": trade_id})

    def reject_trade(self, trade_id: str):
        self._send({"type": "reject_trade", "tradeId": trade_id})

    def build(self, building_type: str, x: int = None, y: int = None):
        a = {"type": "build", "buildingType": building_type}
        if x is not None:
            a["x"] = x
        if y is not None:
            a["y"] = y
        self._send(a)

    def claim(self, x: int, y: int):
        self._send({"type": "claim", "x": x, "y": y})

    def upgrade(self, building_id: str):
        self._send({"type": "upgrade", "buildingId": building_id})

    def sell_land(self, x: int, y: int, price: int, buyer_agent_id: str):
        self._send({"type": "sell_land", "x": x, "y": y, "price": price, "buyerAgentId": buyer_agent_id})

    def deposit(self, amount_sol: float):
        self._send({"type": "deposit", "amountSOL": amount_sol})

    def get_balance(self):
        self._send({"type": "balance"})

    def enter(self, building_id: str):
        self._send({"type": "enter", "buildingId": building_id})

    def inspect(self, target_agent_id: str):
        self._send({"type": "inspect", "targetAgentId": target_agent_id})

    def bridge(self, bridge_name: str, bridge_action: str, params: dict = None):
        self._send({"type": "bridge", "bridge": bridge_name, "bridgeAction": bridge_action, "params": params or {}})

    # --- Building interiors ---
    def enter_building(self, building_id: str):
        self._send({"type": "enter", "buildingId": building_id})

    def exit_building(self):
        self._send({"type": "exit"})

    def interior_move(self, x: int, y: int):
        self._send({"type": "interior_move", "x": x, "y": y})

    # --- Combat ---
    def attack(self, target_agent_id: str):
        self._send({"type": "attack", "targetAgentId": target_agent_id})

    def defend(self, active: bool = True):
        self._send({"type": "defend", "active": active})

    def contest_territory(self, x: int, y: int):
        self._send({"type": "contest_territory", "x": x, "y": y})

    # --- NFT ---
    def mint_nft(self, name: str, description: str, attributes: dict = None, image_url: str = None):
        self.bridge("nft", "mint", {"name": name, "description": description, "attributes": attributes, "imageUrl": image_url})

    def mint_from_template(self, template: str, name: str, attributes: dict = None):
        self.bridge("nft", "mintFromTemplate", {"template": template, "name": name, "attributes": attributes})

    def list_nft(self, mint: str, price_lamports: int):
        self.bridge("nft", "list", {"mint": mint, "price": price_lamports})

    def buy_nft(self, mint: str):
        self.bridge("nft", "buy", {"mint": mint})

    def transfer_nft(self, mint: str, to_wallet: str):
        self.bridge("nft", "transfer", {"mint": mint, "to": to_wallet})

    def burn_nft(self, mint: str):
        self.bridge("nft", "burn", {"mint": mint})

    def get_my_nfts(self):
        self.bridge("nft", "getAssetsByOwner", {})

    # --- Polymarket ---
    def search_markets(self, query: str):
        self.bridge("polymarket", "search", {"query": query})

    def trending_markets(self):
        self.bridge("polymarket", "trending", {})

    def get_market(self, market_id: str):
        self.bridge("polymarket", "getMarket", {"marketId": market_id})

    def buy_outcome(self, market_id: str, outcome: str, amount: float):
        self.bridge("polymarket", "buy", {"marketId": market_id, "outcome": outcome, "amount": amount})

    def sell_outcome(self, market_id: str, outcome: str, shares: float):
        self.bridge("polymarket", "sell", {"marketId": market_id, "outcome": outcome, "shares": shares})

    def get_prediction_portfolio(self):
        self.bridge("polymarket", "getPortfolio", {})

    # --- Social ---
    def tweet(self, text: str):
        self.bridge("social", "postTweet", {"text": text})

    def send_telegram(self, text: str, chat_id: str = None):
        self.bridge("social", "sendTelegram", {"text": text, "chatId": chat_id})

    def send_discord(self, text: str):
        self.bridge("social", "sendDiscord", {"text": text})

    def broadcast_social(self, text: str):
        self.bridge("social", "postAll", {"text": text})

    # --- Data ---
    def get_token_price(self, token: str):
        self.bridge("data", "getPrice", {"token": token})

    def get_trending_tokens(self):
        self.bridge("data", "getTrending", {})

    def search_dex(self, query: str):
        self.bridge("data", "searchDex", {"query": query})

    def get_new_pairs(self):
        self.bridge("data", "getNewPairs", {"chain": "solana"})

    # --- Bounties ---
    def post_bounty(self, title: str, description: str, reward_sol: float, **kwargs):
        self._send({"type": "post_bounty", "title": title, "description": description, "rewardSOL": reward_sol, **kwargs})

    def claim_bounty(self, bounty_id: str, timeout: int = None):
        a = {"type": "claim_bounty", "bountyId": bounty_id}
        if timeout:
            a["timeout"] = timeout
        self._send(a)

    def submit_bounty(self, bounty_id: str, proof: str, notes: str = None):
        self._send({"type": "submit_bounty", "bountyId": bounty_id, "proof": proof, "notes": notes})

    def accept_submission(self, bounty_id: str):
        self._send({"type": "accept_submission", "bountyId": bounty_id})

    def reject_submission(self, bounty_id: str, reason: str = None):
        self._send({"type": "reject_submission", "bountyId": bounty_id, "reason": reason})

    def cancel_bounty(self, bounty_id: str):
        self._send({"type": "cancel_bounty", "bountyId": bounty_id})

    def list_bounties(self, status: str = "open", tag: str = None):
        self._send({"type": "list_bounties", "status": status, "tag": tag})

    # --- Reputation ---
    def rate_agent(self, target_agent_id: str, score: int, comment: str = None):
        self._send({"type": "rate_agent", "targetAgentId": target_agent_id, "score": score, "comment": comment})

    def get_ratings(self, target_agent_id: str = None):
        self._send({"type": "get_ratings", "targetAgentId": target_agent_id})

    # --- Resources ---
    def gather(self, x: int = None, y: int = None):
        a = {"type": "gather"}
        if x is not None:
            a["x"] = x
        if y is not None:
            a["y"] = y
        self._send(a)

    def scan_resources(self, radius: int = 5):
        self._send({"type": "scan_resources", "radius": radius})

    # --- Guilds ---
    def create_guild(self, name: str, description: str = None, tag: str = None):
        self._send({"type": "create_guild", "name": name, "description": description, "tag": tag})

    def join_guild(self, guild_id: str):
        self._send({"type": "join_guild", "guildId": guild_id})

    def leave_guild(self):
        self._send({"type": "leave_guild"})

    def guild_invite(self, target_agent_id: str):
        self._send({"type": "guild_invite", "targetAgentId": target_agent_id})

    def guild_kick(self, target_agent_id: str):
        self._send({"type": "guild_kick", "targetAgentId": target_agent_id})

    def guild_deposit(self, amount_sol: float):
        self._send({"type": "guild_deposit", "amountSOL": amount_sol})

    def guild_info(self, guild_id: str = None):
        self._send({"type": "guild_info", "guildId": guild_id})
