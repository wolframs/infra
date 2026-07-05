/**
 * Starboard service
 *
 * Maps a starred (original) message to the entry the bot posts in the starboard
 * channel. Two lookups are needed:
 *   - by original message id  → to update the entry when its star count changes
 *   - by starboard message id → to route a re-star ON the entry back to the
 *     original message's count (with the usual per-user dedup via bounty_stars).
 *
 * This table is pure bookkeeping; the authoritative star count lives in
 * message_bounties (keyed by the ORIGINAL message id).
 */
import type { Database } from 'better-sqlite3'

export interface StarboardEntry {
  originalMessageId: string
  starboardMessageId: string
  serverId: string | null
  channelId: string | null
}

interface StarboardRow {
  original_message_id: string
  starboard_message_id: string
  server_id: string | null
  channel_id: string | null
}

const toEntry = (r: StarboardRow): StarboardEntry => ({
  originalMessageId: r.original_message_id,
  starboardMessageId: r.starboard_message_id,
  serverId: r.server_id,
  channelId: r.channel_id,
})

/** Look up the starboard entry for an original message (null if not yet posted). */
export function getStarboardEntryByOriginal(db: Database, originalMessageId: string): StarboardEntry | null {
  const row = db.prepare(`
    SELECT original_message_id, starboard_message_id, server_id, channel_id
    FROM starboard_entries WHERE original_message_id = ?
  `).get(originalMessageId) as StarboardRow | undefined
  return row ? toEntry(row) : null
}

/** Look up the entry a starboard POST belongs to (null if the message isn't a starboard post). */
export function getStarboardEntryByPost(db: Database, starboardMessageId: string): StarboardEntry | null {
  const row = db.prepare(`
    SELECT original_message_id, starboard_message_id, server_id, channel_id
    FROM starboard_entries WHERE starboard_message_id = ?
  `).get(starboardMessageId) as StarboardRow | undefined
  return row ? toEntry(row) : null
}

/** Remove the mapping (called when an entry drops below threshold and is deleted). */
export function deleteStarboardEntry(db: Database, originalMessageId: string): void {
  db.prepare(`DELETE FROM starboard_entries WHERE original_message_id = ?`).run(originalMessageId)
}

/** Record the mapping after posting a new starboard entry. */
export function createStarboardEntry(
  db: Database,
  originalMessageId: string,
  starboardMessageId: string,
  serverId: string | null,
  channelId: string | null
): void {
  db.prepare(`
    INSERT INTO starboard_entries (original_message_id, starboard_message_id, server_id, channel_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(original_message_id) DO UPDATE SET starboard_message_id = excluded.starboard_message_id
  `).run(originalMessageId, starboardMessageId, serverId, channelId)
}
