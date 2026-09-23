/**
 * @az runtime framing
 * Purpose: camera framing as data: keep the object in frame at every aspect.
 * Spec: docs/hero-block-spec.md §10
 * Exports: computeFraming, computeCentredFraming, fitsInFrame, CAMERA
 * Edit guide: size against the swept radius, not the bounding box.
 * Tests: packages/scene-runtime/test/scene-runtime.test.ts
 */

/**
 * Scene framing, as data rather than as magic numbers in JSX.
 *
 * Extracted so it can be TESTED. The scene cropped at the right edge twice:
 * once because the object was simply too big, and once because I sized it
 * against the axis-aligned bounding box while the group ROTATES on Y — so the
 * real footprint is the swept disc, not the box. Both were arithmetic errors
 * that a screenshot caught and no assertion did.
 */

export const CAMERA = {
  position: [0, 0.35, 6.0] as const,
  fov: 42,
};

export const GROUP = {
  position: [1.43, -0.24, -0.17] as const,
  scale: 0.66,
};

/** Margin kept between the swept disc and the frame edge, in world units. */
export const EDGE_MARGIN = 0.2;

/** Half-extents of the view at z = 0, for a given aspect ratio. */
export function viewHalfExtents(aspect: number, camera = CAMERA) {
  const halfH = camera.position[2] * Math.tan((camera.fov / 2) * (Math.PI / 180));
  return { halfW: halfH * aspect, halfH };
}

/**
 * Does the rotating object stay inside the frame?
 *
 * `radiusXZ` is the max distance of any vertex from the Y axis — the radius of
 * the disc the object sweeps as it rotates. Using the bounding BOX here is the
 * bug this function exists to prevent.
 */
export interface FramingBox {
  readonly position: readonly [number, number, number];
  readonly scale: number;
}

export function fitsInFrame(radiusXZ: number, aspect: number, group: FramingBox = GROUP) {
  const { halfW, halfH } = viewHalfExtents(aspect);
  const r = radiusXZ * group.scale;
  const right = group.position[0] + r;
  const left = group.position[0] - r;
  return {
    fits: right <= halfW - EDGE_MARGIN && left >= -halfW + EDGE_MARGIN,
    right, left, halfW, halfH, sweptRadius: r,
  };
}

/**
 * Framing resolved FOR AN ASPECT RATIO, not fixed.
 *
 * A single scale/position pair cannot work everywhere: what sits neatly beside
 * the text at 16:9 overflows at 4:3, because the view narrows while the object
 * does not. hero-spec §10 requires every variant to define its behaviour below
 * 768px rather than leaving it to chance — this is that rule applied to the
 * scene instead of to the copy.
 *
 * Wide  → object sits right of the text column.
 * Narrow → the layout stacks, so the object centres and shrinks to fit.
 */
export const WIDE_ASPECT = 1.5;

export function computeFraming(aspect: number, radiusXZ: number) {
  const { halfW } = viewHalfExtents(aspect);
  const wide = aspect >= WIDE_ASPECT;

  const { halfH } = viewHalfExtents(aspect);

  // Where we would LIKE the centre to sit.
  const preferredX = wide ? GROUP.position[0] : 0;
  const preferredScale = wide ? GROUP.scale : GROUP.scale * 0.82;

  // The largest scale that still fits with the margin, at that centre.
  const room = halfW - EDGE_MARGIN - Math.abs(preferredX);
  const maxScale = room / radiusXZ;
  const scale = Math.min(preferredScale, maxScale);

  // RESTACK, not overlap. Narrow viewports put the copy above and the media
  // below (hero-spec §10) — centring the object vertically instead drops it
  // straight behind the paragraph, which §8 forbids without a scrim. Wide
  // layouts keep it beside the text, so no vertical push is needed.
  const y = wide ? GROUP.position[1] : -halfH * 0.42;

  return {
    scale,
    position: [preferredX, y, GROUP.position[2]] as [number, number, number],
    clamped: scale < preferredScale,
    restacked: !wide,
  };
}

/**
 * Framing for a view that owns its whole rectangle — the scene's own box, a
 * hero's media column. Nothing shares the frame, so the object centres and
 * takes the largest scale that keeps its swept disc and its height inside
 * the margin. `computeFraming` above is for an object beside a text column.
 */
export function computeCentredFraming(aspect: number, radiusXZ: number) {
  const { halfW, halfH } = viewHalfExtents(aspect);
  const room = Math.min(halfW, halfH) - EDGE_MARGIN;
  const scale = Math.min(GROUP.scale * 1.25, room / radiusXZ);
  return {
    scale,
    position: [0, 0, GROUP.position[2]] as [number, number, number],
    clamped: scale < GROUP.scale * 1.25,
    restacked: false,
  };
}
