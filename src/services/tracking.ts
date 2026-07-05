/**
 * Message Tracking Service
 * Handles tracking of bot response messages for reaction rewards/tips
 */

import type { Database } from 'better-sqlite3'
import type { TrackedMessage, TrackedMessageRow } from '../types/index.js'
import { getOrCreateUser, getOrCreateServer } from './user.js'
import { logger } from '../utils/logger.js'

/** Messages are tracked for 7 days */
const TRACKING_DURATION_DAYS = 7

/**
 * Track a bot response message for reactions
 * @param triggerMessageId - Optional: the user's message that triggered the bot (for rewarding reactions on it)
 */
export function trackMessage(
  db: Database,
  messageId: string,
  channelId: string,
  serverDiscordId: string,
  botDiscordId: string,
  triggerUserDiscordId: string,
  triggerMessageId?: string
): TrackedMessage {
  // Ensure user and server exist
  const user = getOrCreateUser(db, triggerUserDiscordId)
  const server = getOrCreateServer(db, serverDiscordId)

  // Calculate expiration (7 days from now)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + TRACKING_DURATION_DAYS * 24 * 60 * 60 * 1000)

  // Insert or replace (in case of duplicate)
  db.prepare(`
    INSERT OR REPLACE INTO tracked_messages
      (message_id, channel_id, server_id, bot_discord_id, trigger_user_id, trigger_message_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    messageId,
    channelId,
    server.id,
    botDiscordId,
    user.id,
    triggerMessageId || null,
    expiresAt.toISOString()
  )

  logger.info({
    messageId,
    channelId,
    serverId: server.id,
    botDiscordId,
    triggerUserId: user.id,
    triggerMessageId: triggerMessageId || null,
    expiresAt: expiresAt.toISOString(),
  }, 'Tracked message for reactions')

  return {
    messageId,
    channelId,
    serverId: server.id,
    botDiscordId,
    triggerUserId: user.id,
    triggerMessageId: triggerMessageId || null,
    createdAt: now,
    expiresAt,
  }
}

/**
 * Get a tracked message by message ID (bot's response message)
 * Returns null if not found or expired
 */
export function getTrackedMessage(
  db: Database,
  messageId: string
): (TrackedMessage & { triggerUserDiscordId: string }) | null {
  const row = db.prepare(`
    SELECT 
      tm.message_id,
      tm.channel_id,
      tm.server_id,
      tm.bot_discord_id,
      tm.trigger_user_id,
      tm.trigger_message_id,
      tm.created_at,
      tm.expires_at,
      u.discord_id as trigger_user_discord_id
    FROM tracked_messages tm
    JOIN users u ON tm.trigger_user_id = u.id
    WHERE tm.message_id = ?
    AND datetime(tm.expires_at) > datetime('now')
  `).get(messageId) as (TrackedMessageRow & { trigger_user_discord_id: string }) | undefined

  if (!row) {
    return null
  }

  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    serverId: row.server_id,
    botDiscordId: row.bot_discord_id,
    triggerUserId: row.trigger_user_id,
    triggerMessageId: row.trigger_message_id,
    triggerUserDiscordId: row.trigger_user_discord_id,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
  }
}

/**
 * A logical bot response may be split across several Discord messages (2k-char
 * chunking). All chunks of one response are tracked with the SAME
 * trigger_message_id + bot_discord_id, so we can group them. The "root" is the
 * earliest chunk (smallest snowflake) and is used as the canonical id for star
 * counting / the single starboard entry.
 */
export interface MessageGroup {
  rootId: string
  memberIds: string[]        // all chunk message ids, in send order
  channelId: string
  serverId: string | null
  triggerUserDiscordId: string
}

export function getMessageGroup(db: Database, messageId: string): MessageGroup | null {
  const t = getTrackedMessage(db, messageId)
  if (!t) return null

  let memberIds: string[] = [messageId]
  if (t.triggerMessageId) {
    const rows = db.prepare(`
      SELECT message_id FROM tracked_messages
      WHERE trigger_message_id = ? AND bot_discord_id = ?
      ORDER BY CAST(message_id AS INTEGER) ASC
    `).all(t.triggerMessageId, t.botDiscordId) as Array<{ message_id: string }>
    if (rows.length > 0) memberIds = rows.map(r => r.message_id)
  }
  if (!memberIds.includes(messageId)) memberIds.push(messageId)

  return {
    rootId: memberIds[0]!,
    memberIds,
    channelId: t.channelId,
    serverId: t.serverId,
    triggerUserDiscordId: t.triggerUserDiscordId,
  }
}

/**
 * Get a tracked message by trigger message ID (user's original message that triggered the bot)
 * Returns null if not found or expired
 */
export function getTrackedMessageByTrigger(
  db: Database,
  triggerMessageId: string
): (TrackedMessage & { triggerUserDiscordId: string }) | null {
  const row = db.prepare(`
    SELECT 
      tm.message_id,
      tm.channel_id,
      tm.server_id,
      tm.bot_discord_id,
      tm.trigger_user_id,
      tm.trigger_message_id,
      tm.created_at,
      tm.expires_at,
      u.discord_id as trigger_user_discord_id
    FROM tracked_messages tm
    JOIN users u ON tm.trigger_user_id = u.id
    WHERE tm.trigger_message_id = ?
    AND datetime(tm.expires_at) > datetime('now')
  `).get(triggerMessageId) as (TrackedMessageRow & { trigger_user_discord_id: string }) | undefined

  if (!row) {
    return null
  }

  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    serverId: row.server_id,
    botDiscordId: row.bot_discord_id,
    triggerUserId: row.trigger_user_id,
    triggerMessageId: row.trigger_message_id,
    triggerUserDiscordId: row.trigger_user_discord_id,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
  }
}

/**
 * Clean up expired tracked messages
 * Should be called periodically (e.g., once per hour)
 */
export function cleanupExpiredMessages(db: Database): number {
  const result = db.prepare(`
    DELETE FROM tracked_messages
    WHERE datetime(expires_at) < datetime('now')
  `).run()

  if (result.changes > 0) {
    logger.info({ deleted: result.changes }, 'Cleaned up expired tracked messages')
  }

  return result.changes
}

/**
 * Get count of active tracked messages (for stats)
 */
export function getTrackedMessageCount(db: Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM tracked_messages
    WHERE datetime(expires_at) > datetime('now')
  `).get() as { count: number }

  return row.count
}


