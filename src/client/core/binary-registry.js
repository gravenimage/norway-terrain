/**
 * @file Single source of truth for every binary file format consumed by the client. Each entry names the file format, the four-character magic at offset 0, the producing tool, the consumer module, and a short payload summary. Importing the registry lets discovery tools, tests, and future loaders enumerate the formats without grepping module sources.
 */

/**
 * Frozen entry describing one binary format. The shape is replicated from the per-feature *_CONTRACT exports so consumers can switch to the registry incrementally.
 */
function entry({ magic, filename, producer, consumer, payload }) {
  return Object.freeze({ magic, filename, producer, consumer, payload });
}

export const BINARY_REGISTRY = Object.freeze({
  AMN1: entry({
    magic: 'AMN1',
    filename: 'amenities.bin',
    producer: 'tools/build_amenities.py',
    consumer: 'features/amenities.js',
    payload: 'Civic amenity polygons + prop seeds (parks, pitches, playgrounds).',
  }),
  BLD1: entry({
    magic: 'BLD1',
    filename: 'buildings.bin',
    producer: 'tools/build_buildings.py',
    consumer: 'features/buildings.js',
    payload: 'Stylized Norwegian house and apartment footprints with height bands.',
  }),
  CANO: entry({
    magic: 'CANO',
    filename: 'canopy.bin',
    producer: 'tools/build_canopy.py',
    consumer: 'features/canopy.js',
    payload: 'Procedural canopy tile placements (distance-LOD partner of TRE1/TRE2).',
  }),
  TRE1: entry({
    magic: 'TRE1',
    filename: 'forest.bin (v1)',
    producer: 'tools/build_forest.py',
    consumer: 'features/forest.js',
    payload: 'Per-tree seeds without corner deltas.',
  }),
  TRE2: entry({
    magic: 'TRE2',
    filename: 'forest.bin (v2)',
    producer: 'tools/build_forest.py',
    consumer: 'features/forest.js',
    payload: 'Per-tree seeds with terrain corner deltas for hill-side conformance.',
  }),
  WATR: entry({
    magic: 'WATR',
    filename: 'water.bin',
    producer: 'tools/build_water.py',
    consumer: 'features/water.js',
    payload: 'Inland lake polygons and rivers triangulated for water surface meshes.',
  }),
  OSM2: entry({
    magic: 'OSM2',
    filename: 'osm.bin',
    producer: 'tools/build_osm.py',
    consumer: 'overlays/roads.js',
    payload: 'Road network polylines + kommune boundaries for the drape overlay.',
  }),
  FLT1: entry({
    magic: 'FLT1',
    filename: 'faults.bin',
    producer: 'tools/build_faults.py',
    consumer: 'overlays/faults.js',
    payload: 'Geological fault polylines plotted as overlay lines.',
  }),
  BRR1: entry({
    magic: 'BRR1',
    filename: 'bedrock.bin',
    producer: 'tools/build_geology.py',
    consumer: 'overlays/geology.js',
    payload: 'Indexed bedrock raster with palette JSON.',
  }),
  QRR1: entry({
    magic: 'QRR1',
    filename: 'quaternary.bin',
    producer: 'tools/build_geology.py',
    consumer: 'overlays/geology.js',
    payload: 'Indexed quaternary geology raster with palette JSON.',
  }),
});

/**
 * Returns the registry entry whose magic matches the first four bytes of a parsed view, or undefined when the format is unknown.
 */
export function lookupByMagic(magic) {
  return BINARY_REGISTRY[magic];
}
