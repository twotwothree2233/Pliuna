export type PaneSide = 'left' | 'right'
export const paneMinimum = { left: 180, center: 360, right: 280 } as const
export const separatorWidth = 6
export interface WorkspacePreferences { left: number; right: number; leftOpen: boolean; rightOpen: boolean }
export const defaultWorkspace: WorkspacePreferences = { left: 220, right: 300, leftOpen: true, rightOpen: true }
export interface WorkspaceGeometry {
  width: number; left: number; center: number; right: number
  leftDock: boolean; rightDock: boolean; leftGap: number; rightGap: number; centerMin: number
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min, max), value))

export function fitWorkspace(width: number, preferences: WorkspacePreferences): WorkspaceGeometry {
  const available = Number.isFinite(width) ? Math.max(0, width) : 0
  const centerMin = Math.min(paneMinimum.center, available)
  let leftDock = preferences.leftOpen, rightDock = preferences.rightOpen
  if (leftDock && rightDock && available < paneMinimum.left + paneMinimum.right + centerMin + separatorWidth * 2) rightDock = false
  if (leftDock && available < paneMinimum.left + centerMin + separatorWidth) leftDock = false
  if (rightDock && available < paneMinimum.right + centerMin + separatorWidth) rightDock = false
  const leftGap = leftDock ? separatorWidth : 0, rightGap = rightDock ? separatorWidth : 0
  let left = leftDock ? Math.max(paneMinimum.left, preferences.left) : 0
  let right = rightDock ? Math.max(paneMinimum.right, preferences.right) : 0
  const budget = available - centerMin - leftGap - rightGap
  if (left + right > budget) {
    const leftSlack = leftDock ? left - paneMinimum.left : 0, rightSlack = rightDock ? right - paneMinimum.right : 0
    const slack = leftSlack + rightSlack, excess = left + right - budget
    if (slack > 0) { left -= excess * leftSlack / slack; right -= excess * rightSlack / slack }
  }
  left = leftDock ? Math.max(paneMinimum.left, left) : 0
  right = rightDock ? Math.max(paneMinimum.right, right) : 0
  return { width: available, left, right, center: Math.max(0, available - left - right - leftGap - rightGap), leftDock, rightDock, leftGap, rightGap, centerMin }
}

export function maximumPaneWidth(geometry: WorkspaceGeometry, side: PaneSide): number {
  return Math.max(paneMinimum[side], geometry.width - geometry.centerMin - geometry.leftGap - geometry.rightGap - (side === 'left' ? geometry.right : geometry.left))
}

export function resizeWorkspace(preferences: WorkspacePreferences, geometry: WorkspaceGeometry, side: PaneSide | 'center', value: number): WorkspacePreferences {
  if (!Number.isFinite(value)) return preferences
  const next = { ...preferences }
  if (geometry.leftDock) next.left = geometry.left
  if (geometry.rightDock) next.right = geometry.right
  if (side === 'center') {
    if (!geometry.leftDock && !geometry.rightDock) return preferences
    const center = clamp(value, geometry.centerMin, geometry.width - (geometry.leftDock ? paneMinimum.left + separatorWidth : 0) - (geometry.rightDock ? paneMinimum.right + separatorWidth : 0))
    const sideBudget = geometry.width - center - geometry.leftGap - geometry.rightGap
    if (geometry.leftDock && geometry.rightDock) {
      next.left = clamp(sideBudget * geometry.left / (geometry.left + geometry.right), paneMinimum.left, sideBudget - paneMinimum.right)
      next.right = sideBudget - next.left
    } else if (geometry.leftDock) next.left = sideBudget
    else next.right = sideBudget
  } else {
    if (!geometry[side === 'left' ? 'leftDock' : 'rightDock']) return preferences
    next[side] = clamp(value, paneMinimum[side], maximumPaneWidth(geometry, side))
  }
  return next
}
