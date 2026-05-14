/**
 * @file Builds the perimeter line geometry used by the tile-edge overlay so each terrain tile can be outlined.
 *
 * The geometry traces the outer boundary of a unit plane (1×1 in XY, centred at origin) with a configurable
 * number of segments per edge. Each vertex carries a uv attribute in [0,1]² so the tile-edge vertex shader
 * can compute world XY exactly the same way as the terrain vertex shader.
 */

/**
 * Creates a LineSegments-compatible BufferGeometry tracing the perimeter of a 1×1 unit plane.
 *
 * The result has segCount segments per edge (4 * segCount line segments total) and is intended to be
 * rendered as THREE.LineSegments. Position attributes mirror the layout that PlaneGeometry would emit
 * for the same uv values so the outline aligns 1:1 with the tile mesh.
 */
export function makeTileEdgeGeometry(THREE, segCount) {
  const N = Math.max(1, segCount | 0);
  const verts = N * 4 * 2; // 4 edges × N segments × 2 endpoints
  const positions = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);

  let pi = 0;
  let ui = 0;
  /**
   * Appends one vertex at the given uv on the unit plane, populating position and uv attributes together
   * so the perimeter geometry exactly matches what the terrain vertex shader expects.
   */
  function push(u, v) {
    positions[pi++] = u - 0.5;
    positions[pi++] = v - 0.5;
    positions[pi++] = 0;
    uvs[ui++] = u;
    uvs[ui++] = v;
  }

  // Bottom edge: v=0, u increases.
  for (let i = 0; i < N; i++) {
    push(i / N, 0);
    push((i + 1) / N, 0);
  }
  // Right edge: u=1, v increases.
  for (let i = 0; i < N; i++) {
    push(1, i / N);
    push(1, (i + 1) / N);
  }
  // Top edge: v=1, u decreases (direction is irrelevant for LineSegments but kept for clarity).
  for (let i = 0; i < N; i++) {
    push(1 - i / N, 1);
    push(1 - (i + 1) / N, 1);
  }
  // Left edge: u=0, v decreases.
  for (let i = 0; i < N; i++) {
    push(0, 1 - i / N);
    push(0, 1 - (i + 1) / N);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geom;
}
