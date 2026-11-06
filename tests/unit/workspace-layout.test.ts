import { describe, expect, it } from 'vitest'
import { defaultWorkspace, fitWorkspace, paneMinimum, resizeWorkspace, type WorkspacePreferences } from '../../src/renderer/src/workspace-layout'

describe('workspace geometry', () => {
  it('gives closed panes and separators zero space without changing remembered widths', () => {
    const preferences = { ...defaultWorkspace, left: 310, right: 390 }
    expect(fitWorkspace(1200, { ...preferences, leftOpen: false, rightOpen: false })).toMatchObject({ left: 0, right: 0, leftGap: 0, rightGap: 0, center: 1200 })
    expect(fitWorkspace(1200, preferences)).toMatchObject({ left: 310, right: 390, center: 488 })
  })
  it('folds Agent first, adapts the center below 360px and restores saved widths on growth', () => {
    expect(fitWorkspace(832, defaultWorkspace)).toMatchObject({ leftDock: true, rightDock: true, left: 180, right: 280, center: 360 })
    expect(fitWorkspace(831, defaultWorkspace)).toMatchObject({ leftDock: true, rightDock: false })
    expect(fitWorkspace(546, defaultWorkspace)).toMatchObject({ left: 180, center: 360 })
    expect(fitWorkspace(545, defaultWorkspace)).toMatchObject({ leftDock: false, rightDock: false, center: 545 })
    expect(fitWorkspace(320, defaultWorkspace)).toMatchObject({ center: 320, centerMin: 320 })
    expect(fitWorkspace(1200, defaultWorkspace)).toMatchObject({ left: 220, right: 300 })
  })
  it('clamps side resizing while retaining the other pane and content minimum', () => {
    const geometry = fitWorkspace(1200, defaultWorkspace)
    const left = resizeWorkspace(defaultWorkspace, geometry, 'left', 99999)
    expect(fitWorkspace(1200, left)).toMatchObject({ left: 528, center: 360, right: 300 })
    expect(resizeWorkspace(defaultWorkspace, geometry, 'right', -50).right).toBe(280)
    expect(resizeWorkspace(defaultWorkspace, geometry, 'left', NaN)).toBe(defaultWorkspace)
  })
  it('distributes direct center resizing within both side minimums', () => {
    const geometry = fitWorkspace(1200, defaultWorkspace)
    for (const target of [-1, 470, 99999]) {
      const next = fitWorkspace(1200, resizeWorkspace(defaultWorkspace, geometry, 'center', target))
      expect(next.center).toBeCloseTo(Math.max(360, Math.min(728, target)))
      expect(next.left).toBeGreaterThanOrEqual(180)
      expect(next.right).toBeGreaterThanOrEqual(280)
    }
  })
  it('never exceeds available width or pane minimums across viewport and open-state combinations', () => {
    for (let width = 0; width <= 1800; width += 9) {
      for (const leftOpen of [false, true]) for (const rightOpen of [false, true]) {
        for (const [left, right] of [[180, 280], [220, 300], [800, 900]] as const) {
          const preferences: WorkspacePreferences = { left, right, leftOpen, rightOpen }
          const fit = fitWorkspace(width, preferences)
          expect(fit.left + fit.center + fit.right + fit.leftGap + fit.rightGap).toBeCloseTo(width)
          expect(fit.center).toBeGreaterThanOrEqual(Math.min(paneMinimum.center, width) - 1e-8)
          if (fit.leftDock) expect(fit.left).toBeGreaterThanOrEqual(paneMinimum.left)
          if (fit.rightDock) expect(fit.right).toBeGreaterThanOrEqual(paneMinimum.right)
        }
      }
    }
  })
})
