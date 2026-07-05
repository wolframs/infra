/**
 * Bounty Service
 * 
 * Handles paid star reactions with tiered bounty rewards
 */

import type { Database } from 'better-sqlite3'
import type { BountyTier } from '../types/index.js'
import { logger } from '../utils/logger.js'

/**
 * Check if a user has already starred a message
 */
export function hasStarredMessage(
  db: Database,
  userId: string,
  messageId: string
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM bounty_stars 
    WHERE user_id = ? AND message_id = ?
  `).get(userId, messageId)

  return !!row
}

/**
 * Record a star on a message and increment the star count
 * Returns the new star count
 */
export function recordBountyStar(
  db: Database,
  userId: string,
  messageId: string,
  costPaid: number
): number {
  // Insert star record
  db.prepare(`
    INSERT INTO bounty_stars (user_id, message_id, cost_paid)
    VALUES (?, ?, ?)
  `).run(userId, messageId, costPaid)

  // Upsert message bounty record and increment star count
  db.prepare(`
    INSERT INTO message_bounties (message_id, star_count)
    VALUES (?, 1)
    ON CONFLICT(message_id) DO UPDATE SET
      star_count = star_count + 1
  `).run(messageId)

  // Get new star count
  const row = db.prepare(`
    SELECT star_count FROM message_bounties WHERE message_id = ?
  `).get(messageId) as { star_count: number }

  return row.star_count
}

/**
 * Remove a user's star from a message and decrement the count.
 * Returns the new star count, or null if the user had not starred it.
 */
export function removeBountyStar(
  db: Database,
  userId: string,
  messageId: string
): number | null {
  const del = db.prepare(`
    DELETE FROM bounty_stars WHERE user_id = ? AND message_id = ?
  `).run(userId, messageId)

  if (del.changes === 0) return null

  db.prepare(`
    UPDATE message_bounties SET star_count = MAX(0, star_count - 1) WHERE message_id = ?
  `).run(messageId)

  const row = db.prepare(`
    SELECT star_count FROM message_bounties WHERE message_id = ?
  `).get(messageId) as { star_count: number } | undefined

  return row ? row.star_count : 0
}

/**
 * Get current bounty status for a message
 */
export function getMessageBounty(
  db: Database,
  messageId: string
): { starCount: number; tiersClaimed: number[] } | null {
  const row = db.prepare(`
    SELECT star_count, tiers_claimed FROM message_bounties WHERE message_id = ?
  `).get(messageId) as { star_count: number; tiers_claimed: string } | undefined

  if (!row) {
    return null
  }

  return {
    starCount: row.star_count,
    tiersClaimed: JSON.parse(row.tiers_claimed) as number[],
  }
}

/**
 * Check which tiers have been newly crossed and should be paid out
 * Returns array of tier indices that need to be claimed
 */
export function getNewlyUnlockedTiers(
  starCount: number,
  tiersClaimed: number[],
  tiers: BountyTier[]
): number[] {
  const newlyUnlocked: number[] = []

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]
    // If we've reached the threshold and haven't claimed this tier yet
    if (starCount >= tier.threshold && !tiersClaimed.includes(i)) {
      newlyUnlocked.push(i)
    }
  }

  return newlyUnlocked
}

/**
 * Mark tiers as claimed for a message
 */
export function markTiersClaimed(
  db: Database,
  messageId: string,
  tierIndices: number[]
): void {
  // Get current tiers claimed
  const bounty = getMessageBounty(db, messageId)
  if (!bounty) return

  const updatedTiers = [...new Set([...bounty.tiersClaimed, ...tierIndices])]

  db.prepare(`
    UPDATE message_bounties SET tiers_claimed = ? WHERE message_id = ?
  `).run(JSON.stringify(updatedTiers), messageId)

  logger.debug({
    messageId,
    newTiersClaimed: tierIndices,
    allTiersClaimed: updatedTiers,
  }, 'Marked bounty tiers as claimed')
}

/**
 * Get total stars given by a user (for stats)
 */
export function getUserStarsGiven(db: Database, userId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM bounty_stars WHERE user_id = ?
  `).get(userId) as { count: number }

  return row.count
}

/**
 * Get total ichor spent on stars by a user (for stats)
 */
export function getUserStarSpending(db: Database, userId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_paid), 0) as total FROM bounty_stars WHERE user_id = ?
  `).get(userId) as { total: number }

  return row.total
}

/**
 * Cleanup old bounty data (call periodically)
 * Removes bounty records for messages older than the tracking period
 */
export function cleanupOldBounties(db: Database, daysOld: number = 30): number {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString()

  // Delete old star records
  const starsDeleted = db.prepare(`
    DELETE FROM bounty_stars WHERE created_at < ?
  `).run(cutoff).changes

  // Delete old bounty records
  const bountiesDeleted = db.prepare(`
    DELETE FROM message_bounties WHERE created_at < ?
  `).run(cutoff).changes

  if (starsDeleted > 0 || bountiesDeleted > 0) {
    logger.info({
      starsDeleted,
      bountiesDeleted,
      daysOld,
    }, 'Cleaned up old bounty data')
  }

  return starsDeleted + bountiesDeleted
}

