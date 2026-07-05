/**
 * Message grouping — a long bot response split across several Discord messages
 * shares one trigger_message_id + bot_discord_id, so getMessageGroup collapses
 * the chunks to a single group (root = earliest snowflake). This is what makes
 * a star on ANY chunk resolve to one starboard entry.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SCHEMA } from '../db/schema.js'
import { getMessageGroup } from './tracking.js'

const FAR_FUTURE = '2099-01-01T00:00:00.000Z'

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  db.exec(SCHEMA)
  db.prepare('INSERT INTO users (id, discord_id) VALUES (?, ?)').run('user-1', 'discord-1')
  return db
}

function track(db: any, messageId: string, botId: string, triggerId: string | null) {
  db.prepare(`
    INSERT INTO tracked_messages (message_id, channel_id, server_id, bot_discord_id, trigger_user_id, trigger_message_id, expires_at)
    VALUES (?, 'chan-1', NULL, ?, 'user-1', ?, ?)
  `).run(messageId, botId, triggerId, FAR_FUTURE)
}

// realistic snowflakes (chunk A < chunk B numerically)
const A = '1523015690251141243'
const B = '1523015691744055437'

describe('getMessageGroup', () => {
  let db: ReturnType<typeof freshDb>
  beforeEach(() => { db = freshDb() })

  it('groups two chunks of one response; root is the earliest snowflake', () => {
    track(db, A, 'bot-1', 'trig-1')
    track(db, B, 'bot-1', 'trig-1')

    const fromB = getMessageGroup(db, B)
    expect(fromB?.rootId).toBe(A)
    expect(fromB?.memberIds).toEqual([A, B])

    // starring the other chunk resolves to the same group + root
    const fromA = getMessageGroup(db, A)
    expect(fromA?.rootId).toBe(A)
    expect(fromA?.memberIds).toEqual([A, B])
  })

  it('a single-message response is its own group', () => {
    track(db, A, 'bot-1', 'trig-1')
    const g = getMessageGroup(db, A)
    expect(g?.rootId).toBe(A)
    expect(g?.memberIds).toEqual([A])
  })

  it('does not merge different bots sharing a trigger', () => {
    track(db, A, 'bot-1', 'trig-1')
    track(db, B, 'bot-2', 'trig-1') // different bot
    expect(getMessageGroup(db, A)?.memberIds).toEqual([A])
    expect(getMessageGroup(db, B)?.memberIds).toEqual([B])
  })

  it('a null-trigger message stands alone', () => {
    track(db, A, 'bot-1', null)
    track(db, B, 'bot-1', null)
    expect(getMessageGroup(db, A)?.memberIds).toEqual([A])
  })

  it('returns null for an untracked message', () => {
    expect(getMessageGroup(db, '999')).toBeNull()
  })
})
