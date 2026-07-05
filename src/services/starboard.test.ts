/**
 * Unit coverage for the starboard mapping service.
 *
 * The starboard_entries table links an original (starred) message to the entry
 * the bot posts in the starboard channel, enabling (a) updating the entry when
 * the count changes, and (b) routing a re-star ON the entry back to the
 * original. These assert the two lookups and the upsert-on-conflict behaviour.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SCHEMA } from '../db/schema.js'
import {
  createStarboardEntry,
  getStarboardEntryByOriginal,
  getStarboardEntryByPost,
} from './starboard.js'

function freshDb() {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

describe('starboard service', () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => { db = freshDb() })

  it('roundtrips an entry by original and by post id', () => {
    createStarboardEntry(db, 'orig-1', 'post-1', 'srv-1', 'chan-1')

    const byOrig = getStarboardEntryByOriginal(db, 'orig-1')
    expect(byOrig).toEqual({
      originalMessageId: 'orig-1',
      starboardMessageId: 'post-1',
      serverId: 'srv-1',
      channelId: 'chan-1',
    })

    const byPost = getStarboardEntryByPost(db, 'post-1')
    expect(byPost?.originalMessageId).toBe('orig-1')
  })

  it('returns null for unknown ids', () => {
    expect(getStarboardEntryByOriginal(db, 'nope')).toBeNull()
    expect(getStarboardEntryByPost(db, 'nope')).toBeNull()
  })

  it('upserts on conflict (re-post keeps one row, new post id)', () => {
    createStarboardEntry(db, 'orig-1', 'post-1', 'srv-1', 'chan-1')
    createStarboardEntry(db, 'orig-1', 'post-2', 'srv-1', 'chan-1')

    // Old post id no longer maps anywhere...
    expect(getStarboardEntryByPost(db, 'post-1')).toBeNull()
    // ...and the original now points at the new post.
    expect(getStarboardEntryByOriginal(db, 'orig-1')?.starboardMessageId).toBe('post-2')

    const count = db.prepare('SELECT COUNT(*) AS n FROM starboard_entries').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('keeps distinct originals separate', () => {
    createStarboardEntry(db, 'orig-1', 'post-1', 'srv-1', 'chan-1')
    createStarboardEntry(db, 'orig-2', 'post-2', 'srv-1', 'chan-1')
    expect(getStarboardEntryByPost(db, 'post-1')?.originalMessageId).toBe('orig-1')
    expect(getStarboardEntryByPost(db, 'post-2')?.originalMessageId).toBe('orig-2')
  })
})
