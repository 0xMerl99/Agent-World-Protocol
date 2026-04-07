/**
 * AppearanceSystem — Procedural agent and building appearance generation.
 */

module.exports = function(WorldState) {
  const proto = WorldState.prototype;

  proto._hashSeed = function(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  };

  proto._seededRandom = function(seed, index) {
    const x = Math.sin(seed + index * 9301 + 49297) * 49979;
    return x - Math.floor(x);
  };

  proto._pickFrom = function(arr, seed, index) {
    return arr[Math.floor(this._seededRandom(seed, index) * arr.length)];
  };

  proto._generateAppearance = function(seedStr) {
    const seed = this._hashSeed(seedStr);

    const SKIN_TONES = [
      '#f8d8b4', '#e8c8a0', '#d4a878', '#c49060',
      '#a87048', '#8a5838', '#f0c8a8', '#e0b890',
      '#c89870', '#6a4030',
    ];

    const HAIR_COLORS = [
      '#1a1a2a', '#2a2018', '#4a3020', '#6a4a2a',
      '#8a6a30', '#b48a3a', '#d4a840', '#c44a2a',
      '#8a2a1a', '#e8c888', '#4a2a4a', '#2a3a5a',
    ];

    const HAIR_STYLES = [
      'short', 'medium', 'long', 'spiky', 'mohawk', 'bald',
    ];

    const SHIRT_COLORS = [
      '#4a6ab4', '#b44a4a', '#3a9a4a', '#b4944a',
      '#8a4ab4', '#4ab4a4', '#b46a8a', '#6a8ab4',
    ];

    const PANTS_COLORS = [
      '#2a3a5a', '#3a3a3a', '#4a3a2a', '#2a4a3a', '#3a2a4a', '#4a4a5a',
    ];

    const ACCESSORIES = [
      'none', 'glasses', 'hat', 'scarf', 'bandana',
    ];

    return {
      skinTone: this._pickFrom(SKIN_TONES, seed, 0),
      hairColor: this._pickFrom(HAIR_COLORS, seed, 1),
      hairStyle: this._pickFrom(HAIR_STYLES, seed, 2),
      shirtColor: this._pickFrom(SHIRT_COLORS, seed, 3),
      pantsColor: this._pickFrom(PANTS_COLORS, seed, 4),
      accessory: this._pickFrom(ACCESSORIES, seed, 5),
      seed: seed,
    };
  };

  proto._generateBuildingAppearance = function(ownerSeedStr, buildingType) {
    const seed = this._hashSeed(ownerSeedStr);

    const WALL_PALETTES = [
      { primary: '#aa8a5a', secondary: '#8a6a3a', trim: '#6a4a2a' },
      { primary: '#b8a080', secondary: '#9a8060', trim: '#7a6040' },
      { primary: '#c8b8a0', secondary: '#a89880', trim: '#887860' },
      { primary: '#a09a90', secondary: '#808a80', trim: '#607060' },
      { primary: '#b0a0b0', secondary: '#908090', trim: '#706070' },
      { primary: '#c0a890', secondary: '#a08870', trim: '#806850' },
      { primary: '#8a9aaa', secondary: '#6a7a8a', trim: '#4a5a6a' },
      { primary: '#b0a8a0', secondary: '#908880', trim: '#706860' },
    ];

    const ROOF_PALETTES = [
      { primary: '#7a3a2a', secondary: '#9a5a4a' },
      { primary: '#3a5a7a', secondary: '#5a7a9a' },
      { primary: '#4a6a3a', secondary: '#6a8a5a' },
      { primary: '#6a4a6a', secondary: '#8a6a8a' },
      { primary: '#5a5a6a', secondary: '#7a7a8a' },
      { primary: '#7a6a3a', secondary: '#9a8a5a' },
      { primary: '#8a3a3a', secondary: '#aa5a5a' },
      { primary: '#3a6a6a', secondary: '#5a8a8a' },
    ];

    const DOOR_COLORS = [
      '#5a3a1a', '#3a4a5a', '#5a2a2a', '#2a4a3a',
      '#4a3a4a', '#3a3a2a', '#6a4a2a', '#2a3a4a',
    ];

    const WINDOW_STYLES = [
      'warm', 'cool', 'cozy', 'bright',
    ];

    const AWNING_COLORS = [
      { stripe1: '#c44a3a', stripe2: '#e8e0c8' },
      { stripe1: '#3a6ab4', stripe2: '#e8e8e8' },
      { stripe1: '#4a8a4a', stripe2: '#e8e8d8' },
      { stripe1: '#b48a3a', stripe2: '#f0e8d0' },
      { stripe1: '#8a4a8a', stripe2: '#e8d8e8' },
    ];

    const walls = this._pickFrom(WALL_PALETTES, seed, 10);
    const roof = this._pickFrom(ROOF_PALETTES, seed, 11);

    return {
      walls,
      roof,
      doorColor: this._pickFrom(DOOR_COLORS, seed, 12),
      windowStyle: this._pickFrom(WINDOW_STYLES, seed, 13),
      awning: this._pickFrom(AWNING_COLORS, seed, 14),
      level: 1,
      seed: seed,
    };
  };
};
