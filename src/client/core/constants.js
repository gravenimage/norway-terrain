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
