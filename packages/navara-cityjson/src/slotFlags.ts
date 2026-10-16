/**
 * The flag bits a slot's style texel carries in its alpha. Their own module,
 * free of `three`, so the colour-layer logic can name them without the GPU
 * side.
 */
export const SLOT_HIDDEN = 1;
export const SLOT_SELECTED = 2;
export const SLOT_HOVERED = 4;
/** The slot's image is on screen: draw white, so the map is unmodulated. */
export const SLOT_TEXTURED = 8;
