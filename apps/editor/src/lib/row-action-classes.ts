/**
 * A tree row control that a fine pointer reveals on row hover or focus; touch
 * and keyboard users always see it.
 */
export const QUIET_ROW_ACTION =
  "[@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:[[role=treeitem]:hover_&]:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:[[role=treeitem]:focus-within_&]:opacity-100";
