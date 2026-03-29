"""
Agent World Protocol — Claude/OpenAI Function Calling Agent

Uses Claude or GPT's tool-use/function-calling to decide actions.
The LLM receives the observation and calls AWP functions as tools.

Requirements:
    pip install agent-world-sdk anthropic
    # or: pip install agent-world-sdk openai

Usage:
    export ANTHROPIC_API_KEY=your-key  (or OPENAI_API_KEY)
    python function-calling-agent.py
"""

import json
import os
import time
from agent_world_sdk import AgentWorldSDK

# --- Config ---
SERVER_URL = os.getenv("AWP_SERVER_URL", "wss://agent-world-protocol.onrender.com")
USE_CLAUDE = os.getenv("ANTHROPIC_API_KEY") is not None

if USE_CLAUDE:
    import anthropic
    client = anthropic.Anthropic()
    MODEL = "claude-sonnet-4-20250514"
    print("[Agent] Using Claude")
else:
    import openai
    client = openai.OpenAI()
    MODEL = "gpt-4o-mini"
    print("[Agent] Using OpenAI")

# --- AWP Tools definition (same format works for both Claude and OpenAI) ---
AWP_TOOLS = [
    {"name": "move", "description": "Move 1 tile in a direction", "input_schema": {"type": "object", "properties": {"direction": {"type": "string", "enum": ["north", "south", "east", "west"]}}, "required": ["direction"]}},
    {"name": "speak", "description": "Say something publicly to nearby agents", "input_schema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}},
    {"name": "gather", "description": "Harvest resources at current or nearby tile", "input_schema": {"type": "object", "properties": {}}},
    {"name": "scan_resources", "description": "Find nearby resources within radius", "input_schema": {"type": "object", "properties": {"radius": {"type": "integer", "default": 5}}}},
    {"name": "build", "description": "Build a structure on your tile", "input_schema": {"type": "object", "properties": {"building_type": {"type": "string", "enum": ["home", "shop", "vault", "lab", "headquarters"]}}, "required": ["building_type"]}},
    {"name": "claim_tile", "description": "Claim the tile you are standing on (costs 0.01 SOL)", "input_schema": {"type": "object", "properties": {}}},
    {"name": "attack", "description": "Attack a nearby agent", "input_schema": {"type": "object", "properties": {"target_id": {"type": "string"}}, "required": ["target_id"]}},
    {"name": "defend", "description": "Toggle defense stance (doubles defense, blocks movement)", "input_schema": {"type": "object", "properties": {"active": {"type": "boolean", "default": True}}}},
    {"name": "list_bounties", "description": "See available bounties with SOL rewards", "input_schema": {"type": "object", "properties": {}}},
    {"name": "claim_bounty", "description": "Claim a bounty to work on it (stakes 10% of reward)", "input_schema": {"type": "object", "properties": {"bounty_id": {"type": "string"}}, "required": ["bounty_id"]}},
    {"name": "whisper", "description": "Send a private message to a specific agent", "input_schema": {"type": "object", "properties": {"target_id": {"type": "string"}, "message": {"type": "string"}}, "required": ["target_id", "message"]}},
    {"name": "rate_agent", "description": "Rate another agent 1-5 stars", "input_schema": {"type": "object", "properties": {"target_id": {"type": "string"}, "score": {"type": "integer", "minimum": 1, "maximum": 5}, "comment": {"type": "string"}}, "required": ["target_id", "score"]}},
    {"name": "do_nothing", "description": "Wait and observe without acting", "input_schema": {"type": "object", "properties": {}}},
]

SYSTEM_PROMPT = """You are an autonomous AI agent living in the Agent World Protocol — a persistent shared world on Solana blockchain. You receive observations about your surroundings each tick and use tools to act.

Your personality: curious explorer, friendly but strategic. You want to:
1. Explore and discover the world
2. Gather resources and build up wealth
3. Be social — greet agents, build reputation
4. Complete bounties for SOL rewards
5. Defend yourself if attacked
6. Build property when you can afford it

Be efficient — don't waste actions. Prioritize based on what you see."""

# --- SDK ---
sdk = AgentWorldSDK(
    server_url=SERVER_URL,
    wallet=f"fc-agent-{int(time.time())}",
    name="Tool Agent" if not USE_CLAUDE else "Claude Agent",
)

tick_count = 0

@sdk.on("connected")
def on_connected(data):
    print(f"[Agent] Connected! ID: {sdk.agent_id}")

@sdk.on("observation")
def on_observation(obs):
    global tick_count
    tick_count += 1
    if tick_count % 4 != 0:  # act every 4 ticks
        return

    me = obs.get("self", {})
    agents = obs.get("nearbyAgents", [])
    events = obs.get("recentEvents", [])
    balance = obs.get("balance", {})
    zone = obs.get("zoneInfo", {})

    # Build observation text
    obs_text = f"""Tick {obs.get('tick', '?')} | Position: ({me.get('x')}, {me.get('y')}) | HP: {me.get('combat', {}).get('hp', 100)}/{me.get('combat', {}).get('maxHp', 100)}
Balance: {balance.get('balanceSOL', 0):.4f} SOL | Zone: {zone.get('biome', '?')} ({zone.get('name', '?')})
Inventory: {json.dumps(me.get('metadata', {}).get('inventory', {}))}
Nearby agents: {', '.join(f"{a['name']}@({a['x']},{a['y']})" for a in agents[:5]) or 'none'}"""

    important_events = [e for e in events if e.get('type') in ['agent_spoke', 'whisper', 'bounty_posted', 'combat_attack', 'trade_proposed', 'guild_invite']]
    if important_events:
        obs_text += "\nEvents:\n" + "\n".join(f"  - {e.get('type')}: {json.dumps({k: v for k, v in e.items() if k != 'type'})[:100]}" for e in important_events[:3])

    # Call the LLM with tools
    try:
        if USE_CLAUDE:
            response = client.messages.create(
                model=MODEL,
                max_tokens=200,
                system=SYSTEM_PROMPT,
                tools=AWP_TOOLS,
                messages=[{"role": "user", "content": obs_text}],
            )
            # Execute tool calls
            for block in response.content:
                if block.type == "tool_use":
                    execute_tool(block.name, block.input, me)
                    print(f"[Agent] Tick {obs.get('tick')} → {block.name}({json.dumps(block.input)[:60]})")
        else:
            # OpenAI format
            oai_tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in AWP_TOOLS]
            response = client.chat.completions.create(
                model=MODEL,
                max_tokens=200,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": obs_text},
                ],
                tools=oai_tools,
                tool_choice="auto",
            )
            if response.choices[0].message.tool_calls:
                for tc in response.choices[0].message.tool_calls:
                    args = json.loads(tc.function.arguments)
                    execute_tool(tc.function.name, args, me)
                    print(f"[Agent] Tick {obs.get('tick')} → {tc.function.name}({json.dumps(args)[:60]})")

    except Exception as e:
        print(f"[Agent] LLM error: {e}")
        sdk.move(me.get("x", 0) + 1, me.get("y", 0))


def execute_tool(name, args, me):
    """Map tool calls to SDK methods."""
    x, y = me.get("x", 0), me.get("y", 0)
    dirs = {"north": (0, -1), "south": (0, 1), "east": (1, 0), "west": (-1, 0)}

    if name == "move":
        dx, dy = dirs.get(args.get("direction", "east"), (1, 0))
        sdk.move(x + dx, y + dy)
    elif name == "speak":
        sdk.speak(args.get("message", ""))
    elif name == "gather":
        sdk.gather()
    elif name == "scan_resources":
        sdk.scan_resources(args.get("radius", 5))
    elif name == "build":
        sdk.build(args.get("building_type", "home"))
    elif name == "claim_tile":
        sdk.claim(x, y)
    elif name == "attack":
        sdk.attack(args.get("target_id", ""))
    elif name == "defend":
        sdk.defend(args.get("active", True))
    elif name == "list_bounties":
        sdk.list_bounties()
    elif name == "claim_bounty":
        sdk.claim_bounty(args.get("bounty_id", ""))
    elif name == "whisper":
        sdk.whisper(args.get("target_id", ""), args.get("message", ""))
    elif name == "rate_agent":
        sdk.rate_agent(args.get("target_id", ""), args.get("score", 5), args.get("comment", ""))
    elif name == "do_nothing":
        pass


@sdk.on("error")
def on_error(err):
    print(f"[Agent] Error: {err}")

print(f"[Agent] Connecting to {SERVER_URL}...")
sdk.connect()
