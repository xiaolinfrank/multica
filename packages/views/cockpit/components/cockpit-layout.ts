const MIN_DATE_VIEWPORT = 320;
const COMPACT_TREE_MAX = 320;
const TABLE_CODE_WIDTH = 100;
const TABLE_NAME_WIDTH = 260;

/** Full metadata is useful only when a readable date window still fits beside it. */
export function cockpitGanttLayout(width: number, showFinance: boolean, exporting = false) {
  const fullTreeWidth = showFinance ? 800 : 680;
  const compact = !exporting && width < fullTreeWidth + MIN_DATE_VIEWPORT;
  return {
    compact,
    // Split narrow viewports evenly; deeper trees must not consume the date axis.
    treeWidth: compact ? Math.min(COMPACT_TREE_MAX, Math.floor((width > 0 ? width : 320) / 2)) : fullTreeWidth,
  };
}

/** Keep the code as an address, but let names scroll when two frozen columns crowd out data. */
export function cockpitTableLayout(width: number) {
  return {
    codeWidth: TABLE_CODE_WIDTH,
    nameWidth: TABLE_NAME_WIDTH,
    pinName: width >= TABLE_CODE_WIDTH + TABLE_NAME_WIDTH + MIN_DATE_VIEWPORT,
  };
}
