# NTW Custom Map Enlarger

Complete browser toolkit for enlarging Napoleon: Total War community battle
maps. Import a map folder zip, enlarge 2x, edit trees and buildings, export.
Everything runs client-side.

## Run

    npm install
    npm run dev        # http://localhost:5173

## What it does

**Import** a zip of a map folder (definition.xml, height_map_N.dds/png +
settings, colour_map_0, bmd.tree_list, ...). The viewer renders:

- heightmap stretched across the full terrain (how the engine treats it)
- colour_map_0 confined to the original inner ring (how the engine samples it)
- trees (dots, per species) and deployment zones (per battle-config block)

**Shader fix (the streak solution)**: feed the app your game's grid.fx
(extract with Pack File Manager). The terrain shader computes colour/blend
UVs as world_position / terrain_size_meters + 0.5 with the CPU always
feeding 2048 — so enlarged maps clamp-smear past +/-1024 m. The app patches
the divisor (x2) at all 3 vertex-shader variants + the texel offset and
downloads a fixed grid.fx. Install it into the shader pack and delete the
shader cache so it recompiles. One-time per game install; verified in-game.

**2x Enlarge** rewrites, in one click:

- definition.xml: base_terrain_width/height x2
- all height_map_N_settings.xml: world_width/height x2 (atomic per file —
  this is the recipe that gives stable, non-morphing terrain)
- optional: set the heightmap `scale` attribute (height exaggeration)
- optional: multiply tree coordinates x2 (spread trees with the terrain)

Heightmap and colour map PIXELS are never touched.

**Edit** trees (place / cluster brush / erase, per species) and deployment zones (drag, numeric x/y/w/h, bulk shift-all-outward across every block). Undo supported.

**Export** writes a zip: edited XMLs, rebuilt tree_list / building_list
(all size, count and link-chain fields recomputed), patched farm bounds,
and byte-identical passthrough of every other file.

## Format notes (reverse-engineered, round-trip verified)

- tree_list: LRDZ (14-byte records) and RIKI (16-byte records); 4-5 size
  fields in header+footer that must shift when the file grows — verified
  byte-identical on 43 community maps.
