/**
 * @file Owns the LOD fade-band formula shared by buildings, canopy range, and amenity area materials. Centralising the formula keeps the inner-edge "comfortable fade band, never less than X fraction of the far edge" invariant consistent across feature systems.
 */

/**
 * Computes the inner (`near`) edge of a distance fade band given the outer (`far`) range.
 *
 * The result is `max(farMetres - bandMetres, farMetres * floorFraction)`: when
 * the far range is large enough we get a fixed-width band, but at small ranges
 * the band shrinks proportionally instead of collapsing to zero or going
 * negative.
 */
export function computeFadeRange(farMetres, { bandMetres, floorFraction }) {
  return Math.max(farMetres - bandMetres, farMetres * floorFraction);
}
