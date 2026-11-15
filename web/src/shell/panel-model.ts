/** The legend panel's pure rules: which tabs exist, which one shows, and whether it starts open. */

/** The known tabs, in the order they are shown. */
export const PANEL_TABS = ['graph', 'cost'] as const
export type PanelTabId = (typeof PANEL_TABS)[number]

/** Wide enough to start with the panel open. */
export const OPEN_FROM = 1400
/** Below this width the panel overlays the page instead of pushing it. */
export const OVERLAY_BELOW = 1000

export const defaultPanelOpen = (width: number): boolean => width >= OPEN_FROM

/** The filled tabs in the known order. */
export function orderTabs(filled: readonly string[]): PanelTabId[] {
  return PANEL_TABS.filter((id) => filled.includes(id))
}

/**
 * The tab to show: the one picked by hand while it stays filled, else the one the page filled last
 * (`filled` is in the order the tabs were filled), else none.
 */
export function chooseTab(filled: readonly string[], picked: string | null): PanelTabId | null {
  const known = orderTabs(filled)
  if (known.length === 0) return null
  if (picked && known.includes(picked as PanelTabId)) return picked as PanelTabId
  return orderTabs([filled[filled.length - 1]])[0] ?? known[0]
}
