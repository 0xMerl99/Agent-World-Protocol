# AWP Assets

Drop PNG sprite sheets here. The viewer loads them from `/assets/...` URLs.

```
assets/
├── tiles/
│   ├── ground.png           — 7 biome ground tilesets
│   ├── water.png            — lake, river, sea tiles
│   ├── roads.png            — dirt path, stone, road, bridge
│   ├── elevation.png        — hills, cliffs, mountains
│   ├── farm.png             — crops, wheat, garden
│   └── special.png          — park, forest floor, sand, snow
├── characters/
│   ├── agents.png           — 8 variants × 4 dirs × 4 frames
│   └── accessories.png      — glasses, hat, scarf, bandana overlays
├── buildings/
│   ├── home_level1.png      — through home_level3.png
│   ├── shop_level1.png      — through shop_level3.png
│   ├── vault_level1.png     — through vault_level3.png
│   ├── lab_level1.png       — through lab_level3.png
│   └── headquarters_level1.png — through headquarters_level3.png
├── props/
│   ├── trees.png            — 16 tree/vegetation sprites
│   ├── objects.png          — 32 object sprites
│   └── flowers.png          — 16 flower sprites
├── features/
│   └── large.png            — pond, lake, river, windmill, bridges, etc.
└── effects/
    ├── smoke.png            — 4-frame chimney smoke
    ├── sparkle.png          — 4-frame gold sparkle
    ├── leaves.png           — 32 falling leaf variants
    ├── snow.png             — 28 snowflake variants
    ├── rain.png             — 9 rain streak variants
    └── speech_bubble.png    — speech bubble overlay
```

See `docs/SPRITE_SPECIFICATION.md` for full details.
