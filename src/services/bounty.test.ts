/**
 * Star add/remove/dedup cycle — the invariant behind the starboard count and
 * its removal-below-threshold behaviour. (FKs aren't enforced on this raw
 * in-memory connection, so we can exercise the counters without seeding users.)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SCHEMA } from '../db/schema.js'
import { hasStarredMessage, recordBountyStar, removeBountyStar } from './bounty.js'

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF') // isolate the star counters from users(id) FK
  db.exec(SCHEMA)
  return db
}

describe('bounty stars: add / remove / dedup', () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => { db = freshDb() })

  it('counts distinct users and dedups a repeat check', () => {
    expect(recordBountyStar(db, 'u1', 'm1', 0)).toBe(1)
    expect(hasStarredMessage(db, 'u1', 'm1')).toBe(true)
    expect(hasStarredMessage(db, 'u2', 'm1')).toBe(false)
    expect(recordBountyStar(db, 'u2', 'm1', 0)).toBe(2)
  })

  it('removeBountyStar decrements and returns the new count', () => {
    recordBountyStar(db, 'u1', 'm1', 0)
    recordBountyStar(db, 'u2', 'm1', 0)
    expect(removeBountyStar(db, 'u1', 'm1')).toBe(1)
    expect(hasStarredMessage(db, 'u1', 'm1')).toBe(false)
    expect(removeBountyStar(db, 'u2', 'm1')).toBe(0)
  })

  it('returns null when removing a star the user never gave', () => {
    recordBountyStar(db, 'u1', 'm1', 0)
    expect(removeBountyStar(db, 'ghost', 'm1')).toBeNull()
    // count untouched
    recordBountyStar(db, 'u2', 'm1', 0)
    expect(removeBountyStar(db, 'u2', 'm1')).toBe(1)
  })

  it('never goes below zero', () => {
    recordBountyStar(db, 'u1', 'm1', 0)
    expect(removeBountyStar(db, 'u1', 'm1')).toBe(0)
    // idempotent-ish: a second remove for an absent record is a no-op (null)
    expect(removeBountyStar(db, 'u1', 'm1')).toBeNull()
  })
})
