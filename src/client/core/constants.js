/**
 * @file Owns viewer-wide default constants used before metadata or UI controls provide runtime values. Keep these values side-effect free so modules can import them without bootstrapping the viewer.
 */

export const ELEV_MAX = 1800;
export const CAMERA_STORAGE_KEY = 'norwayterrain.cam.v1';
export const DEFAULT_EXAGGERATION = 1.4;
export const DEFAULT_SSE_PX = 3;
export const DEFAULT_SEGMENTS = 64;
export const DEFAULT_DRAPE_OFFSET_METRES = 12;
export const DEFAULT_BUILDING_RANGE_KM = 22;
export const DEFAULT_CANOPY_RANGE_KM = 30;
export const DEFAULT_CANOPY_LOD_KM = 1.5;
export const TREE_CANOPY_FADE_WIDTH_METRES = 300;

/**
 * Inner-edge offset for amenity fade. Buildings/amenities reach full opacity
 * BUILDING_FADE_BAND_METRES short of the visible range, clamped so the band
 * never collapses past BUILDING_FADE_FLOOR_FRACTION of the range.
 */
export const BUILDING_FADE_BAND_METRES = 4000;
export const BUILDING_FADE_FLOOR_FRACTION = 0.7;

/**
 * Half-width of the canopy LOD transition around the slider midpoint. The
 * MIN_CANOPY_LOD_LO_METRES floor keeps the near edge above the camera even
 * at very small midpoints.
 */
export const CANOPY_LOD_HALF_BAND_METRES = 300;
export const MIN_CANOPY_LOD_LO_METRES = 50;

/**
 * Canopy fade-near inset relative to the canopy far range, so the band fades
 * over the last CANOPY_RANGE_INNER_DELTA_METRES of the visible distance, but
 * never collapses past CANOPY_RANGE_FADE_FLOOR_FRACTION of the far range.
 */
export const CANOPY_RANGE_INNER_DELTA_METRES = 2000;
export const CANOPY_RANGE_FADE_FLOOR_FRACTION = 0.85;
