import { describe, expect, test } from 'bun:test'
import { chooseTab, defaultPanelOpen, orderTabs } from './panel-model'

describe('legend panel', () => {
  test('opens by default from 1400 px', () => {
    expect(defaultPanelOpen(1399)).toBe(false)
    expect(defaultPanelOpen(1400)).toBe(true)
  })
  test('tabs show in the known order, unknown ids dropped', () => {
    expect(orderTabs(['cost', 'graph', 'x'])).toEqual(['graph', 'cost'])
  })
  test('the last filled tab shows unless one was picked and is still filled', () => {
    expect(chooseTab([], null)).toBeNull()
    expect(chooseTab(['cost'], null)).toBe('cost')
    expect(chooseTab(['cost', 'graph'], null)).toBe('graph')
    expect(chooseTab(['cost', 'graph'], 'cost')).toBe('cost')
    expect(chooseTab(['graph'], 'cost')).toBe('graph')
  })
})
