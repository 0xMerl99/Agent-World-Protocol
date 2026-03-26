# Agent World Protocol — Complete Sprite Sheet Specification

## For Pixel Artists

This document specifies every sprite sheet needed for the AWP isometric world viewer. The art style should match the reference images provided: warm, detailed pixel art similar to Stardew Valley / Eastward — hand-painted feel, rich colors, environmental storytelling.

All sprites are PNG files with transparent backgrounds.

---

## ISOMETRIC PERSPECTIVE — READ THIS FIRST

The entire world is rendered in **2:1 isometric projection**. Every asset must be drawn from this specific camera angle.

### Camera Angle
- The camera looks DOWN at the world from a **fixed elevated angle (~30° from horizontal)**
- The camera faces **SOUTH-EAST** — you see the TOP surface of the ground, the LEFT wall face of buildings, and the FRONT wall face of buildings
- Think of it as looking at a tabletop from a seated position across the corner
- The camera NEVER rotates — this angle is fixed for all assets

### How Isometric Tiles Work
```
        ╱╲           ← ONE tile viewed from above
       ╱  ╲          
      ╱    ╲         Width: 64 pixels
      ╲    ╱         Height: 32 pixels (top face only)
       ╲  ╱          Height: 40 pixels (with 8px side depth)
        ╲╱
```

- A flat tile is a **diamond shape** (rhombus): 64px wide, 32px tall
- The top-left and top-right edges recede into the distance
- The bottom-left and bottom-right edges are closer to the camera
- Tiles with depth (raised ground) show **left side face** and **right side face** below the diamond, adding ~8px of height
- Side faces follow the light rule: left face lighter, right face darker

### Tile Grid (How Tiles Connect)
```
            ╱╲
           ╱ A╲
          ╱    ╲╱╲
          ╲    ╱ B╲
           ╲╱ ╱    ╲
           ╱╲╱╲    ╱
          ╱ C╲ ╲  ╱
         ╱    ╲ ╲╱
         ╲    ╱
          ╲  ╱
           ╲╱
```
Tiles tessellate — each diamond's right edge connects to the next tile's left edge. There are NO gaps between tiles.

### Coordinate System
```
              NORTH (away from camera)
                 ↗
       WEST ←  tile  → EAST
                 ↙
              SOUTH (toward camera)
```

- Moving NORTH = tile slides UP-RIGHT on screen
- Moving EAST = tile slides DOWN-RIGHT on screen
- Moving SOUTH = tile slides DOWN-LEFT on screen
- Moving WEST = tile slides UP-LEFT on screen

### Light Direction
- Light comes from **TOP-LEFT** (northwest) on every single sprite
- Left-facing surfaces are **lighter** (receive direct light)
- Right-facing surfaces are **darker** (in shadow)
- Top surfaces are the **base color** (brightest overall)
- Cast shadows fall to the bottom-right
- All sprites must use this consistent lighting — no exceptions

### What This Means For Each Asset Type

**Ground tiles:** You see the TOP surface of the ground. If the tile is raised, you also see the left side face (lighter) and right side face (darker) below the diamond.

**Characters:** Viewed from above and slightly in front. HEAD at top of sprite, FEET at bottom. They cast a small shadow ellipse below their feet. When facing SOUTH (toward camera), you see their face, chest, front of legs. When facing NORTH (away), you see the back of their head, back, heels. When facing EAST/WEST, you see them in profile.

**Buildings:** You see the TOP of the roof, the FRONT wall (facing south toward camera), and the LEFT wall (facing east). The right wall and back wall are hidden. Doors and main entrances always face SOUTH (toward camera). Chimneys, roof peaks, and antennas are visible from above.

**Trees and tall props:** Viewed from above. Tree canopies appear as round/oval shapes from this angle. The trunk is partially visible below the canopy. The bottom of the trunk meets the ground where a shadow ellipse sits.

**Water:** Viewed from above — you see the water surface. Shore edges show where ground meets water at the tile boundary.

### Scale Reference
```
One tile:        64×32px diamond (one "square" of world space)
Character:       32×48px (stands centered on one tile)
Small building:  64×80px (occupies one tile footprint)
Large building:  96×112px (wider than one tile)
Tree:            48×64px (canopy extends beyond its tile)
Small prop:      16×16 to 32×32px (sits on a tile)
```

---

## 1. TERRAIN TILESETS

The world is made of isometric tiles. Each tile is a **64×40 pixel** diamond (64 wide, 32 tall for the top face, plus 8px for side depth). Terrain is organized into categories, not just biomes — a village zone might contain grass, paths, water, flowers, and fences all together.

### 1A. BASE GROUND TILES

**File:** `tiles/ground.png`
**Cell:** 64×40 per tile
**Layout:** 8 columns × 7 rows = 56 tiles
**Sheet size:** 512×280

Each row is a biome. Each column is a variant.

| Col | Purpose |
|-----|---------|
| 0 | Base ground A — primary, most used |
| 1 | Base ground B — slight color shift |
| 2 | Base ground C — with small detail (pebble, grass tuft, crack) |
| 3 | Base ground D — another variation |
| 4 | Sparse detail — a few grass blades, small stones |
| 5 | Dense detail — more texture, busier surface |
| 6 | Edge tile — darker, used at zone borders |
| 7 | Raised block — same ground with visible left + right side faces (3D depth) |

| Row | Biome | Base Color | Mood |
|-----|-------|-----------|------|
| 0 | Village | Lush green grass | Bright, spring morning |
| 1 | Autumn Town | Warm orange-brown earth | Cozy, rainy afternoon |
| 2 | Farmland | Golden-yellow soil | Harvest, golden hour |
| 3 | Industrial | Dark gray stone/concrete | Gritty, overcast |
| 4 | Wilderness | Deep green wild grass | Untamed, overgrown |
| 5 | Highlands | Rocky brown-gray | Rugged, windswept |
| 6 | Winter Town | White-blue snow | Cold, festive |

### 1B. WATER TILES

**File:** `tiles/water.png`
**Cell:** 64×40
**Layout:** 8 columns × 3 rows = 24 tiles
**Sheet size:** 512×120

| Row | Type | Description |
|-----|------|-------------|
| 0 | Lake / Pond | Still water, darker blue-green, lily pads on some tiles, gentle ripple highlights |
| 1 | River / Stream | Flowing water with directional wave lines, slightly lighter blue, white foam edges |
| 2 | Sea / Ocean | Deep blue, larger waves, whitecap highlights, deeper color than lake |

Columns 0–3: Base water variants (different ripple patterns)
Column 4: Water with shore edge (left side shows sand/grass meeting water)
Column 5: Water with shore edge (right side)
Column 6: Water with shore edge (top)
Column 7: Water with shore edge (bottom)

**Optional animated version:** 3-frame animation for each water type (tiles shift slightly between frames to create flowing effect). If provided, make `water_anim.png` with 3× the width (1536×120).

### 1C. ROAD & PATH TILES

**File:** `tiles/roads.png`
**Cell:** 64×40
**Layout:** 8 columns × 4 rows = 32 tiles
**Sheet size:** 512×160

| Row | Type | Description |
|-----|------|-------------|
| 0 | Dirt path | Narrow worn trail through grass — light brown, grass edges visible |
| 1 | Stone path | Cobblestone walkway — individual stones visible, gray-beige |
| 2 | Road | Wider paved road — smooth stone or packed earth, cart wheel marks |
| 3 | Bridge | Wooden plank bridge — for crossing water tiles, visible planks + railings |

| Col | Variant |
|-----|---------|
| 0 | Straight (NE-SW direction) |
| 1 | Straight (NW-SE direction) |
| 2 | Corner (turns from NE to NW) |
| 3 | Corner (turns from SW to SE) |
| 4 | T-intersection |
| 5 | Crossroads (4-way) |
| 6 | End/dead end |
| 7 | Variation/detail (puddle on path, crack, weeds through stones) |

### 1D. ELEVATION TILES

**File:** `tiles/elevation.png`
**Cell:** 64×40 (but cliff faces extend below — 64×56 for tall cliffs)
**Layout:** 8 columns × 3 rows = 24 tiles
**Sheet size:** 512×168

| Row | Type | Description |
|-----|------|-------------|
| 0 | Hill | Gentle slope — ground tile with one side raised ~8px, grass/earth visible on slope face |
| 1 | Cliff edge | Sharp drop — flat top with rocky cliff face on one or two sides, 16-24px tall face |
| 2 | Mountain base | Rocky terrain meeting a steep rock wall — snow on peak hints, very tall face |

| Col | Facing direction |
|-----|-----------------|
| 0 | Cliff face south |
| 1 | Cliff face west |
| 2 | Cliff face east |
| 3 | Cliff face north |
| 4 | Corner (inner, SW) |
| 5 | Corner (inner, SE) |
| 6 | Corner (outer, SW) |
| 7 | Corner (outer, SE) |

### 1E. FARM TILES

**File:** `tiles/farm.png`
**Cell:** 64×40
**Layout:** 8 columns × 3 rows = 24 tiles
**Sheet size:** 512×120

| Row | Type | Description |
|-----|------|-------------|
| 0 | Crop field | Plowed soil rows with growing green crops — carrots, lettuce, cabbage patches |
| 1 | Wheat field | Golden wheat stalks swaying — dense, tall, harvest-ready |
| 2 | Garden plot | Mixed vegetable garden with fence border, sunflowers, varied plants |

| Col | Growth stage / variant |
|-----|----------------------|
| 0 | Empty/plowed soil (fresh furrows) |
| 1 | Seedling stage (tiny green sprouts) |
| 2 | Growing stage (medium plants visible) |
| 3 | Mature/harvest stage (full plants, colorful) |
| 4-7 | Variants with different crop types or slight layout differences |

### 1F. SPECIAL TERRAIN TILES

**File:** `tiles/special.png`
**Cell:** 64×40
**Layout:** 8 columns × 4 rows = 32 tiles
**Sheet size:** 512×160

| Row | Type | Description |
|-----|------|-------------|
| 0 | Park | Manicured green grass with decorative flower borders, cleaner than wild grass |
| 1 | Forest floor | Dark earth with fallen leaves, tree roots, mushrooms, dense shadow |
| 2 | Sand / Beach | Light tan sand, shells, seaweed at water edge, footprints |
| 3 | Snow variants | Deep snow with footprints, ice patches, frozen puddle, snowdrift |

Columns 0–7: Variants of each (different detail placement)

---

## 2. CHARACTER SPRITES (AGENTS)

**File:** `characters/agents.png`
**Cell:** 32×48 pixels per frame
**Layout:** 16 columns × 8 rows
**Sheet size:** 512×384

### Row Layout (8 color variants):

Each row is a complete character in one color scheme.

| Row | Hair | Shirt | Pants | Skin |
|-----|------|-------|-------|------|
| 0 | Dark brown | Blue | Navy | Light |
| 1 | Black | Red | Dark gray | Medium |
| 2 | Blonde | Green | Brown | Light |
| 3 | Red | Yellow-brown | Dark brown | Light |
| 4 | Purple | Purple | Navy | Medium |
| 5 | Light brown | Teal | Dark gray | Dark |
| 6 | Gray | Pink | Black | Light |
| 7 | Blue-black | Light blue | Charcoal | Medium |

### Column Layout (4 directions × 4 frames = 16 columns):

```
Cols  0-3:  South (facing camera)    — idle, walk1, idle, walk2
Cols  4-7:  West  (facing left)      — idle, walk1, idle, walk2
Cols  8-11: North (facing away)      — idle, walk1, idle, walk2
Cols 12-15: East  (facing right)     — idle, walk1, idle, walk2
```

### Character Design:
- Chibi/SD proportions — large head (~40% of height), compact body
- Clear silhouette readable at 1× and 2× zoom
- Visible features: hair, eyes, shirt color, pants, shoes
- Drop shadow (small ellipse at feet)

### Isometric Character Drawing Guide:

Characters are viewed from the same elevated isometric angle as everything else. This affects how each direction looks:

```
SOUTH (facing camera):              NORTH (facing away):
┌──────────┐                        ┌──────────┐
│   hair    │                        │   hair    │
│  ◉    ◉  │  ← eyes visible        │ (back of  │
│    ╰╯    │  ← mouth visible       │   head)   │
│  ╔════╗  │  ← shirt front         │  ╔════╗  │  ← shirt back
│  ║    ║  │                         │  ║    ║  │
│  ╠─  ─╣  │  ← arms at sides       │  ╠─  ─╣  │
│  ║    ║  │  ← pants                │  ║    ║  │
│  ╚╗  ╔╝  │  ← legs                │  ╚╗  ╔╝  │
│   ║  ║   │                         │   ║  ║   │
│  ░░░░░░  │  ← shadow              │  ░░░░░░  │
└──────────┘                        └──────────┘

WEST (facing left):                 EAST (facing right):
┌──────────┐                        ┌──────────┐
│   hair   │                        │   hair    │
│  ◉ (nose)│  ← one eye, profile    │(nose) ◉  │
│   ╰      │                        │      ╯   │
│  ╔═══╗   │  ← shirt side view     │  ╔═══╗   │
│  ║   ║   │                        │  ║   ║   │
│  ║─  ║   │  ← one arm visible     │  ║  ─║   │
│  ║   ║   │                        │  ║   ║   │
│  ╚╗ ╔╝   │                        │  ╚╗ ╔╝   │
│   ║ ║    │                        │   ║ ║    │
│  ░░░░░░  │                        │  ░░░░░░  │
└──────────┘                        └──────────┘
```

**Key points for isometric characters:**
- Because the camera is elevated, you see SLIGHTLY MORE of the top of the head and shoulders than in a flat side view
- The shadow ellipse on the ground is drawn as an isometric oval (wider than tall, ~10×4px)
- Feet are at the BOTTOM of the sprite — this is where the sprite is anchored to the tile
- When walking, the body bobs up 1-2 pixels on the step frames
- South-facing is the "default" view — this should be the most detailed and expressive
- Arms swing opposite to legs during walk animation

### Walk Animation:
- Frame 0 (idle): Neutral stance, arms relaxed
- Frame 1 (walk1): Left foot forward, right arm forward, slight body lean
- Frame 2 (idle): Same as frame 0 (creates smooth loop)
- Frame 3 (walk2): Right foot forward, left arm forward

### Accessory Overlays (optional separate file):

**File:** `characters/accessories.png`
**Cell:** 32×48
**Layout:** 4 columns (accessories) × 4 rows (directions)
**Sheet size:** 128×192

| Col | Accessory |
|-----|-----------|
| 0 | Glasses — thin frames over eyes |
| 1 | Hat — colored cap matching shirt tone |
| 2 | Scarf — red scarf around neck, trailing end |
| 3 | Bandana — gold headband with trailing tail |

Rows = South, West, North, East (one idle frame per direction, overlaid on character)

---

## 3. BUILDINGS

**Format:** Individual PNG per building type per level
**Perspective:** Isometric front-left view (consistent with tiles)
**All buildings sit on a 1-tile footprint (64×32 base) but extend upward and slightly outward**

### 3A. Home (5 types × 3 levels = 15 files)

**Cell sizes vary by building type:**

| Type | Size | Description |
|------|------|-------------|
| Home | 64×80 | Small cottage — pitched roof, chimney, door, 1-2 windows |
| Shop | 80×96 | Wide building — striped awning, display windows, hanging sign |
| Vault | 64×72 | Heavy stone — flat reinforced roof, iron door, barred windows |
| Lab | 72×88 | Modern/clean — large windows, antenna on roof |
| Headquarters | 96×112 | Grand 2-story — flag, pillars, impressive entrance |

### Level Progression (applies to all types):

**Level 1** — Basic construction
- Simple materials (raw wood, basic stone)
- Small, modest
- 1-2 windows, basic door

**Level 2** — Improved
- Better materials (treated wood, cut stone)
- Flower boxes under windows
- Cleaner construction, painted trim
- Slightly larger footprint impression

**Level 3** — Premium
- Mixed materials (stone base, timber frame, glass)
- Gold or colored trim details
- Lit lanterns at entrance
- Garden elements beside building
- Clearly the nicest version

### Building Notes:
- Drop shadow at base
- Windows glow warm yellow/orange (interior lit)
- Chimneys on homes + HQ (leave space above for animated smoke — we add in code)
- Door faces toward camera (south-facing isometric)
- Each level should be immediately distinguishable at a glance

### Isometric Building Drawing Guide:

Buildings are 3D structures viewed from the same elevated angle as tiles. You see exactly THREE faces:

```
         ╱╲──────╲
        ╱ ROOF TOP ╲
       ╱────────────╲
      │╲              │
      │  ╲    RIGHT   │
      │    ╲  WALL    │
      │ LEFT ╲ (dark) │
      │ WALL   ╲      │
      │ (light)  ╲    │
      │            ╲  │
      │   FRONT     ╲ │
      │   WALL       ╲│
      │  (medium)     │
      │  ┌──────┐     │
      │  │ DOOR │     │
      ╰──┴──────┴─────╯
         ░░░░░░░░░░   ← shadow
```

**Three visible faces:**
1. **ROOF / TOP** — viewed from above, visible as a diamond or peaked shape
2. **LEFT WALL** — faces east, receives light from top-left, so it's the LIGHTER wall
3. **FRONT WALL** — faces south (toward camera), medium brightness, contains the DOOR and main WINDOWS

**The right wall and back wall are NOT visible** from this camera angle.

**Roof styles by building type:**
- Home: peaked/gabled roof (triangle shape from front, diamond from above)
- Shop: flat roof with awning extending over the front wall
- Vault: flat reinforced roof (metal/stone)
- Lab: flat modern roof with equipment (antenna, dish)
- HQ: complex peaked roof, possibly multi-level

**Door and window placement:**
- Door is ALWAYS on the front wall (facing camera/south)
- Windows appear on the front wall and left wall
- Window glow should be visible — warm yellow/orange rectangles
- The front wall is the "face" of the building — most detail goes here

### File Names:
```
buildings/home_level1.png, home_level2.png, home_level3.png
buildings/shop_level1.png, shop_level2.png, shop_level3.png
buildings/vault_level1.png, vault_level2.png, vault_level3.png
buildings/lab_level1.png, lab_level2.png, lab_level3.png
buildings/headquarters_level1.png, headquarters_level2.png, headquarters_level3.png
```

---

## 4. PROPS & DECORATIONS

### 4A. Trees & Vegetation

**File:** `props/trees.png`
**Cell:** 48×64 (trees are tall)
**Layout:** 8 columns × 2 rows = 16 tree sprites
**Sheet size:** 384×128

| Row 0 | Description |
|-------|-------------|
| 0 | Green oak — round canopy, spring/summer |
| 1 | Dark green oak — deeper shade, thicker |
| 2 | Autumn maple — red/orange canopy, leaves falling |
| 3 | Yellow birch — golden leaves |
| 4 | Pine/evergreen — triangular, dark green |
| 5 | Snow pine — pine with snow on branches |
| 6 | Dead tree — leafless, twisted trunk |
| 7 | Fruit tree — green with small red/orange dots (apples/oranges) |

| Row 1 | Description |
|-------|-------------|
| 0 | Small bush — round green |
| 1 | Berry bush — green with red dots |
| 2 | Tall grass — wild grass cluster |
| 3 | Wheat bundle — harvested wheat sheaf |
| 4 | Sunflower — 2-3 tall sunflowers |
| 5 | Corn stalks — 2-3 corn plants |
| 6 | Pumpkin patch — 2 pumpkins with vine |
| 7 | Mushroom cluster — 2-3 colorful mushrooms |

### 4B. Objects & Furniture

**File:** `props/objects.png`
**Cell:** 32×32
**Layout:** 8 columns × 4 rows = 32 objects
**Sheet size:** 256×128

| Row 0 — Structures |
|-----|
| Wooden fence (horizontal segment) |
| Wooden fence (vertical segment) |
| Stone wall (horizontal) |
| Stone wall (vertical) |
| Wooden gate (open) |
| Wooden gate (closed) |
| Well (stone circular well with roof) |
| Fountain (stone fountain with water) |

| Row 1 — Street furniture |
|-----|
| Street lantern (warm glow) |
| Bench (wooden) |
| Sign post (wooden with arrow) |
| Market stall (empty) |
| Market stall (with goods) |
| Trash/crate pile |
| Mailbox |
| Flag pole with banner |

| Row 2 — Containers & tools |
|-----|
| Wooden barrel |
| Wooden crate |
| Stack of barrels (2-3) |
| Stack of crates |
| Wheelbarrow |
| Hay bale |
| Anvil |
| Mining cart |

| Row 3 — Nature details |
|-----|
| Small rock |
| Large boulder |
| Rock cluster (2-3 rocks) |
| Moss-covered rock |
| Log (fallen tree trunk) |
| Tree stump |
| Lily pad cluster (for water tiles) |
| Campfire (with flames) |

### 4C. Flowers

**File:** `props/flowers.png`
**Cell:** 16×16 (small, scattered on ground)
**Layout:** 8 columns × 2 rows = 16 flower types
**Sheet size:** 128×32

| Row 0 | Single flowers |
|-------|------|
| Red poppy | Blue cornflower | Yellow daisy | White lily | Purple violet | Pink rose | Orange tulip | Mixed wildflowers |

| Row 1 | Flower clusters (3-5 flowers grouped) |
|-------|------|
| Red cluster | Blue cluster | Yellow cluster | White cluster | Purple cluster | Mixed warm | Mixed cool | Rainbow mix |

---

## 5. LARGE TERRAIN FEATURES

These are multi-tile decorative elements placed on top of the base terrain. They span 2-4 tiles.

**File:** `features/large.png`
**Various sizes — individual sprites packed into atlas**

| Feature | Size | Description |
|---------|------|-------------|
| Pond | 128×80 | Small oval pond, blue water, grass edges, lily pads, reflections |
| Lake | 192×120 | Larger body of water, deeper blue center, shore all around |
| River section | 128×48 | Flowing water segment, directional, foam at banks, rocks in stream |
| Waterfall | 64×96 | Water cascading down a cliff face with mist spray at bottom |
| Bridge (wood) | 96×48 | Wooden bridge spanning a river/stream, planks + side rails |
| Bridge (stone) | 96×56 | Stone arch bridge, more ornate |
| Windmill | 64×96 | Classic windmill — stone base, wooden blades, rotating implied |
| Cooling tower | 80×112 | Industrial cooling tower from reference images |
| Clock tower | 48×96 | Tall tower with clock face |
| Gazebo | 64×64 | Open garden structure with pointed roof |

---

## 6. UI & EFFECTS

### 6A. Speech Bubble
**File:** `effects/speech_bubble.png`
**Size:** 80×40
- White fill, dark pixel border, pointer tail at bottom
- Should feel hand-drawn/organic, not perfectly rectangular

### 6B. Smoke Animation
**File:** `effects/smoke.png`
**Cell:** 16×16 per frame
**Layout:** 4 frames horizontal = 64×16
- Frame 0: Small white-gray puff
- Frame 1: Expanding, more transparent
- Frame 2: Larger, very transparent
- Frame 3: Nearly gone, wisps

### 6C. Sparkle / Transaction Effect
**File:** `effects/sparkle.png`
**Cell:** 16×16 per frame
**Layout:** 4 frames = 64×16
- Yellow-gold sparkle, small star shape, grows then fades

### 6D. Falling Leaves (for Autumn zones)
**File:** `effects/leaves.png`
**Cell:** 8×8 per frame
**Layout:** 4 leaf variants × 4 fall frames = 128×8
- Red, orange, brown, yellow individual leaves tumbling

### 6E. Snowflakes (for Winter zones)
**File:** `effects/snow.png`
**Cell:** 8×8
**Layout:** 4 variants = 32×8
- Tiny white crystalline shapes, slightly different each

### 6F. Rain (for Autumn zones)
**File:** `effects/rain.png`
**Cell:** 8×16
**Layout:** 3 variants = 24×16
- Diagonal rain streaks, thin blue-white lines

---

## 7. FILE DELIVERY STRUCTURE

```
assets/
├── tiles/
│   ├── ground.png              (512×280)  — 7 biomes × 8 variants
│   ├── water.png               (512×120)  — lake, river, sea × 8 variants
│   ├── roads.png               (512×160)  — path, stone, road, bridge × 8 variants
│   ├── elevation.png           (512×168)  — hill, cliff, mountain × 8 directions
│   ├── farm.png                (512×120)  — crops, wheat, garden × 8 stages
│   └── special.png             (512×160)  — park, forest floor, sand, snow × 8 variants
│
├── characters/
│   ├── agents.png              (512×384)  — 8 variants × 16 frames
│   └── accessories.png         (128×192)  — 4 accessories × 4 directions (optional)
│
├── buildings/
│   ├── home_level1.png         (64×80)
│   ├── home_level2.png         (64×80)
│   ├── home_level3.png         (64×80)
│   ├── shop_level1.png         (80×96)
│   ├── shop_level2.png         (80×96)
│   ├── shop_level3.png         (80×96)
│   ├── vault_level1.png        (64×72)
│   ├── vault_level2.png        (64×72)
│   ├── vault_level3.png        (64×72)
│   ├── lab_level1.png          (72×88)
│   ├── lab_level2.png          (72×88)
│   ├── lab_level3.png          (72×88)
│   ├── headquarters_level1.png (96×112)
│   ├── headquarters_level2.png (96×112)
│   └── headquarters_level3.png (96×112)
│
├── props/
│   ├── trees.png               (384×128)  — 16 trees/vegetation
│   ├── objects.png             (256×128)  — 32 objects/furniture
│   └── flowers.png             (128×32)   — 16 flower types
│
├── features/
│   └── large.png               (packed atlas, various sizes)
│       — pond, lake, river, waterfall, bridges, windmill, towers, gazebo
│
└── effects/
    ├── speech_bubble.png       (80×40)
    ├── smoke.png               (64×16)    — 4 frames
    ├── sparkle.png             (64×16)    — 4 frames
    ├── leaves.png              (128×8)    — 16 frames
    ├── snow.png                (32×8)     — 4 variants
    └── rain.png                (24×16)    — 3 variants
```

---

## 8. COMPLETE ASSET COUNT

| Category | Assets | Sprites |
|----------|--------|---------|
| Ground tiles | 7 sheets | 56 tiles |
| Water tiles | 1 sheet | 24 tiles |
| Road/path tiles | 1 sheet | 32 tiles |
| Elevation tiles | 1 sheet | 24 tiles |
| Farm tiles | 1 sheet | 24 tiles |
| Special terrain | 1 sheet | 32 tiles |
| Characters | 1 sheet | 128 frames (8 variants × 4 dirs × 4 frames) |
| Accessories | 1 sheet | 16 overlays (optional) |
| Buildings | 15 files | 15 buildings (5 types × 3 levels) |
| Trees & vegetation | 1 sheet | 16 sprites |
| Objects & furniture | 1 sheet | 32 sprites |
| Flowers | 1 sheet | 16 sprites |
| Large features | 1 atlas | ~10 features |
| Effects | 6 files | ~30 frames |
| **Total** | **~30 files** | **~420+ sprites** |

---

## 9. STYLE GUIDELINES

**Color:** Warm, saturated palette. Not washed out. Rich greens, deep blues, warm browns. Every biome should have a dominant color temperature.

**Shading:** 3-4 tone shading (base color, shadow, highlight, optional deep shadow). Light comes from top-left.

**Outlines:** Subtle dark outlines on characters and buildings (1px). Tiles do NOT have outlines — they blend seamlessly.

**Pixel density:** This is meant to be viewed at 1× to 3× zoom. Details should be readable at 2× but not require 3×.

**Atmosphere:** Each biome tells a story. Village feels safe and social. Autumn feels cozy with rain. Farmland feels productive with golden light. Industrial feels gritty with smoke. Wilderness feels adventurous. Highlands feel rugged. Winter feels festive but harsh.

**Consistency:** All assets should feel like they belong in the same game. Same pixel density, same lighting direction, same level of detail, same color temperature within a biome.

**Reference:** See the 7 concept images provided — those are the target quality and mood.
