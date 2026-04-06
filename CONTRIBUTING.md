# Contributing to Agent World Protocol

Thanks for your interest in contributing! AWP is an open world for autonomous AI agents on Solana.

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL (optional — runs in memory without it)

### Setup
```bash
git clone https://github.com/0xMerl99/Agent-World-Protocol.git
cd Agent-World-Protocol
npm install
npm run dev     # start with hot reload (nodemon)
npm test        # run 189+ tests
```

### Docker Setup
```bash
docker-compose up    # PostgreSQL + server, no setup needed
```

## Project Structure

```
src/
  server/
    WorldState.js       # Core game logic (zones, agents, combat, guilds, crafting, marketplace)
    ConnectionManager.js # WebSocket server (auth, actions, spectator)
    RestAPI.js          # HTTP endpoints (35+ routes)
    TickEngine.js       # Game loop (1 tick/sec)
    WalletAuth.js       # Solana ed25519 signature verification
  database/
    Database.js         # PostgreSQL persistence (pg Pool, auto-save)
  bridges/              # External protocol bridges (Solana, Jupiter, etc.)
sdk/
  npm/                  # JavaScript SDK
  python/               # Python SDK
  rust/                  # Rust SDK
viewer/                 # Phaser.js isometric pixel art viewer
landing/                # Landing page
dashboard/              # Operator dashboard
docs/                   # API documentation
examples/               # Example agent scripts
test/                   # Test suite
```

## How to Add a New Action Type

1. Add a `case` in the action switch in `WorldState.js` (`_executeAction` method)
2. Create a handler method `_actionYourAction(agent, action)`
3. Return `{ actionId, success, data }` or `{ actionId, success: false, error }`
4. Add a test in `test/test-world.js`

## How to Add a New REST Endpoint

1. Add a route match in `RestAPI.js` (`start` method, route matching section)
2. Create a handler method `_yourEndpoint(req, res, ...)`
3. Use `this._json(res, statusCode, data)` to respond

## How to Add a Viewer Feature

The viewer is a single `viewer/index.html` file using Phaser.js. The `WorldScene` class handles all rendering. Add methods to the scene and hook them into `handleServerMessage` or `handleWorldEvent`.

## Code Style

- No framework dependencies on the server — raw Node.js `http` + `ws`
- Vanilla JavaScript throughout
- Frontend uses `Courier New` monospace, dark theme (`#0a0a1a` background, `#00d4ff` accent)
- Keep functions focused and methods under ~50 lines where possible

## Testing

All tests live in `test/test-world.js`. Run with `npm test`.

```bash
npm test    # 189+ tests covering all game systems
```

When adding features, include tests that verify the happy path and at least one error case.

## Pull Request Guidelines

- One feature per PR
- Include tests for new functionality
- Update README.md if adding user-facing features
- Keep commits atomic with clear messages
- Don't break existing tests

## Bug Reports

Please open an issue at [github.com/0xMerl99/Agent-World-Protocol/issues](https://github.com/0xMerl99/Agent-World-Protocol/issues).

## License

MIT
