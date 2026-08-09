/**
 * Where a card sits in a column, and how it gets there without moving everything else.
 *
 * The naive version numbers cards 0,1,2,3. Dragging one to the top then rewrites every
 * card beneath it: one gesture, N writes, and two people dragging at the same time
 * produce an order neither of them asked for.
 *
 * So positions are floats with big gaps between them, and a card dropped between two
 * neighbours takes the midpoint of the two. One row changes. Nobody else's card moves,
 * so a second person dragging elsewhere in the column cannot collide.
 *
 * This is fractional indexing - the same idea as Jira's LexoRank and Figma's fractional
 * indices, expressed as a double instead of a string because Postgres already sorts
 * doubles and the alternative buys nothing here.
 *
 * The catch, and it is the only one: halving a gap repeatedly runs out of mantissa.
 * Dropping a card in the same seam ~50 times in a row gets the two neighbours close
 * enough that their midpoint equals one of them, and the order becomes ambiguous.
 * `needsRebalance` spots that, and the caller renumbers that one bucket back onto clean
 * spacing. In practice this is rare enough that most boards never do it, and cheap
 * enough that it does not matter when they do.
 */

/** The gap between freshly spaced cards. A power of two, so midpoints stay exact. */
export const POSITION_STEP = 65536;

/**
 * Below this, two neighbours are too close to reliably split again.
 *
 * Doubles have ~15-16 significant digits, so this leaves a wide margin: it triggers a
 * rebalance long before a midpoint could round to one of its own endpoints.
 */
const MIN_GAP = 1e-6;

/** The position for a card appended after everything currently in the column. */
export function positionAfterLast(lastPosition: number | undefined): number {
	return (lastPosition ?? 0) + POSITION_STEP;
}

/**
 * The position for a card dropped between two neighbours.
 *
 * Either side may be missing - dropping at the top of a column has no card above it,
 * dropping at the bottom none below - and an empty column has neither.
 */
export function positionBetween(before: number | undefined, after: number | undefined): number {
	if (before === undefined && after === undefined) return POSITION_STEP;

	// Dropped at the top: half the distance to zero, which never collides with anything
	// below it and never needs the rest of the column touched.
	if (before === undefined) return (after as number) / 2;

	if (after === undefined) return before + POSITION_STEP;

	return (before + after) / 2;
}

/** Have the neighbours drifted too close together to keep splitting? */
export function needsRebalance(before: number | undefined, after: number | undefined): boolean {
	if (before === undefined || after === undefined) return false;

	return Math.abs(after - before) < MIN_GAP;
}

/** Clean spacing for a column being renumbered: 1x, 2x, 3x ... the step. */
export function rebalancedPositions(count: number): number[] {
	return Array.from({ length: count }, (_, index) => (index + 1) * POSITION_STEP);
}
