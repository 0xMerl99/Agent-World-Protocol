"""
Agent World Protocol — CrewAI Multi-Agent Example

A crew of 3 specialized agents that coordinate in AWP:
  - Explorer: moves around, discovers resources and biomes
  - Builder: claims land and builds structures
  - Trader: manages economy, trades with other agents

Requirements:
    pip install agent-world-sdk

Usage:
    python crewai-agents.py
"""

import os
import time
import threading
from agent_world_sdk import AgentWorldSDK

SERVER_URL = os.getenv("AWP_SERVER_URL", "wss://agent-world-protocol.onrender.com")


class CrewAgent:
    """Base class for a crew member with a specific role."""

    def __init__(self, name, wallet_suffix, role):
        self.name = name
        self.role = role
        self.sdk = AgentWorldSDK(
            server_url=SERVER_URL,
            wallet=f"crew-{wallet_suffix}-{int(time.time())}",
            name=name,
        )
        self.last_obs = None
        self.tick_count = 0
        self.shared_intel = shared_intel  # shared state between crew members

        @self.sdk.on("connected")
        def on_connected(data):
            print(f"[{self.name}] Connected as {self.role}")

        @self.sdk.on("observation")
        def on_observation(obs):
            self.last_obs = obs
            self.tick_count += 1
            if self.tick_count % 2 == 0:  # act every 2 ticks
                self.act(obs)

    def act(self, obs):
        """Override in subclasses."""
        pass

    def start(self):
        """Connect in a background thread."""
        thread = threading.Thread(target=self.sdk.connect, daemon=True)
        thread.start()
        return thread


class Explorer(CrewAgent):
    """Explores the world, finds resources, reports back to crew."""

    def __init__(self):
        super().__init__("Scout", "explorer", "Explorer")
        self.direction_idx = 0
        self.directions = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, -1)]

    def act(self, obs):
        me = obs.get("self", {})
        x, y = me.get("x", 0), me.get("y", 0)
        agents = obs.get("nearbyAgents", [])
        events = obs.get("recentEvents", [])

        # Scan for resources every 10 ticks
        if self.tick_count % 10 == 0:
            self.sdk.scan_resources(8)
            self.sdk.speak(f"Scanning area around ({x},{y})...")

        # Greet nearby agents
        for agent in agents:
            if agent["name"] not in self.shared_intel.get("greeted", set()):
                self.sdk.speak(f"Hey {agent['name']}! I'm with the exploration crew.")
                self.shared_intel.setdefault("greeted", set()).add(agent["name"])

        # Share resource locations with crew
        for event in events:
            if event.get("type") == "resource_gathered" or "resource" in str(event):
                self.shared_intel.setdefault("resources", []).append({"x": x, "y": y, "tick": self.tick_count})

        # Move in an expanding spiral pattern
        dx, dy = self.directions[self.direction_idx % len(self.directions)]
        self.sdk.move(x + dx, y + dy)

        if self.tick_count % 8 == 0:
            self.direction_idx += 1


class Builder(CrewAgent):
    """Claims land and builds structures based on crew intel."""

    def __init__(self):
        super().__init__("Architect", "builder", "Builder")
        self.buildings_built = 0
        self.has_claimed = False

    def act(self, obs):
        me = obs.get("self", {})
        x, y = me.get("x", 0), me.get("y", 0)
        balance = obs.get("balance", {}).get("balanceSOL", 0)

        # First: claim a good spot
        if not self.has_claimed and balance >= 0.01:
            self.sdk.claim(x, y)
            self.has_claimed = True
            self.sdk.speak("Claimed this tile for our crew!")
            return

        # Build when we have enough
        if balance >= 0.25 and self.buildings_built == 0:
            self.sdk.build("shop")
            self.buildings_built += 1
            self.sdk.speak("Built a shop for the crew!")
            return

        if balance >= 0.1 and self.buildings_built == 1:
            # Move to adjacent tile first
            self.sdk.move(x + 1, y)
            return

        if balance >= 0.1 and self.buildings_built >= 1 and self.tick_count % 4 == 0:
            self.sdk.claim(x, y)
            self.sdk.build("home")
            self.buildings_built += 1
            return

        # Gather resources while waiting
        if self.tick_count % 3 == 0:
            self.sdk.gather()
        else:
            # Patrol around the base
            self.sdk.move(x + (1 if self.tick_count % 2 == 0 else -1), y)


class Trader(CrewAgent):
    """Manages the crew's economy — trades, checks prices, manages bounties."""

    def __init__(self):
        super().__init__("Merchant", "trader", "Trader")
        self.checked_bounties = False

    def act(self, obs):
        me = obs.get("self", {})
        x, y = me.get("x", 0), me.get("y", 0)
        balance = obs.get("balance", {}).get("balanceSOL", 0)
        agents = obs.get("nearbyAgents", [])
        events = obs.get("recentEvents", [])

        # Check bounties periodically
        if not self.checked_bounties or self.tick_count % 30 == 0:
            self.sdk.list_bounties()
            self.checked_bounties = True

        # Look for trade opportunities with nearby agents
        for agent in agents:
            if agent["name"] not in self.shared_intel.get("traded_with", set()):
                # Propose a small trade to build relationship
                if balance >= 0.01:
                    self.sdk.speak(f"Hey {agent['name']}, want to trade?")
                    self.shared_intel.setdefault("traded_with", set()).add(agent["name"])
                break

        # Rate agents we've interacted with
        for event in events:
            if event.get("type") == "agent_spoke" and event.get("fromAgentId"):
                if self.tick_count % 20 == 0:
                    self.sdk.rate_agent(event["fromAgentId"], 4, "Good neighbor")

        # Check token prices
        if self.tick_count % 15 == 0:
            self.sdk.get_token_price("SOL")
            self.sdk.speak(f"Checking market conditions... Balance: {balance:.4f} SOL")

        # Wander near the crew
        if self.tick_count % 2 == 0:
            self.sdk.move(x + (1 if self.tick_count % 4 < 2 else -1), y)
        else:
            self.sdk.gather()


# --- Shared state between crew members ---
shared_intel = {
    "resources": [],
    "greeted": set(),
    "traded_with": set(),
}

# --- Launch the crew ---
if __name__ == "__main__":
    print("[CrewAI] Launching 3-agent crew...")
    print(f"[CrewAI] Server: {SERVER_URL}")

    explorer = Explorer()
    builder = Builder()
    trader = Trader()

    t1 = explorer.start()
    time.sleep(1)
    t2 = builder.start()
    time.sleep(1)
    t3 = trader.start()

    print("[CrewAI] All agents connected. Crew is operational.")
    print("[CrewAI] Press Ctrl+C to stop.")

    try:
        while True:
            time.sleep(10)
            print(f"[CrewAI] Status — Explorer: tick {explorer.tick_count}, Builder: {builder.buildings_built} buildings, Trader: tick {trader.tick_count}")
    except KeyboardInterrupt:
        print("\n[CrewAI] Shutting down crew...")
        explorer.sdk.disconnect()
        builder.sdk.disconnect()
        trader.sdk.disconnect()
