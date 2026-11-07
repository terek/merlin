import { describe, expect, test } from 'bun:test'
import { parseRepoCut, placePath } from './cuts'

describe('parseRepoCut', () => {
  test('old and new values', () => {
    expect(parseRepoCut('branch')).toBe('branch')
    expect(parseRepoCut('checkout')).toBe('checkout')
    expect(parseRepoCut('remote')).toBe('remote')
    expect(parseRepoCut(null)).toBe('repo')
    expect(parseRepoCut('nope')).toBe('repo')
  })
})

describe('placePath', () => {
  test('rows count primary values: no touched', () => {
    expect(placePath('repo', '/w/acme/.git')).toBe('/?group=repo&repo=%2Fw%2Facme%2F.git')
    expect(placePath('checkout', '/w/acme/main')).toBe('/?group=checkout&checkout=%2Fw%2Facme%2Fmain')
    expect(placePath('remote', 'h.example/acme')).toBe('/?group=remote&remote=h.example%2Facme')
  })
  test('the row of none is -', () => {
    expect(placePath('repo', '')).toBe('/?group=repo&repo=-')
    expect(placePath('checkout', '')).toBe('/?group=checkout&checkout=-')
    expect(placePath('remote', '')).toBe('/?group=remote&remote=-')
  })
  test('branch rows split at the first #', () => {
    expect(placePath('branch', '/w/a/.git#fix#1')).toBe('/?group=repo&repo=%2Fw%2Fa%2F.git&branch=fix%231')
    expect(placePath('branch', '#main')).toBe('/?group=repo&repo=-&branch=main')
  })
  test('beads', () => {
    expect(placePath('bead', 'x-1')).toBe('/?group=bead&bead=x-1')
  })
})
