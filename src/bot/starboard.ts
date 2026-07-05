/**
 * Starboard — showcase starred messages in a dedicated channel.
 *
 * Flow:
 *   - When a message's star count reaches the threshold, post an embed of it to
 *     the starboard channel (or update the existing embed's count).
 *   - When someone stars the STARBOARD entry itself, route that star back to the
 *     original message's count — deduped per user via bounty_stars, so a user
 *     only ever adds one star to a given message no matter where they click.
 *
 * The authoritative star count is message_bounties (keyed by the ORIGINAL id).
 */
import { EmbedBuilder } from 'discord.js'
import type { Client, TextChannel, MessageReaction, PartialMessageReaction, User } from 'discord.js'
import type { Database } from 'better-sqlite3'
import type { ServerConfig } from '../types/index.js'
import {
  getStarboardEntryByOriginal,
  createStarboardEntry,
  type StarboardEntry,
} from '../services/starboard.js'
import { hasStarredMessage, recordBountyStar } from '../services/bounty.js'
import { getOrCreateUser, extractDiscordUserInfo } from '../services/user.js'
import { getBalance, deductBalanceSimple } from '../services/balance.js'
import { getTrackedMessage } from '../services/tracking.js'
import { logger } from '../utils/logger.js'

const STAR = '⭐'
const MAX_CONTENT = 1000

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** Build (or rebuild) the showcase embed for a starred message. */
function buildEmbed(opts: {
  authorName: string
  authorIcon?: string | null
  content: string
  jumpUrl: string
  starCount: number
}): EmbedBuilder {
  const body = opts.content.trim().length > 0 ? truncate(opts.content, MAX_CONTENT) : '*[no text content]*'
  return new EmbedBuilder()
    .setColor(0xffb638)
    .setTitle(`${STAR} ${opts.starCount}`)
    .setAuthor({ name: opts.authorName, iconURL: opts.authorIcon || undefined })
    .setDescription(`${body}\n\n[Jump to message](${opts.jumpUrl})`)
}

/** Edit an existing starboard post's star count in place (preserves the rest). */
async function updateCount(
  client: Client,
  channelId: string,
  starboardMessageId: string,
  newCount: number
): Promise<boolean> {
  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null
    if (!channel) return false
    const msg = await channel.messages.fetch(starboardMessageId)
    const existing = msg.embeds[0]
    const rebuilt = existing
      ? EmbedBuilder.from(existing).setTitle(`${STAR} ${newCount}`)
      : new EmbedBuilder().setTitle(`${STAR} ${newCount}`)
    await msg.edit({ embeds: [rebuilt] })
    return true
  } catch (error) {
    logger.warn({ error, starboardMessageId }, 'Starboard: failed to update entry count')
    return false
  }
}

/**
 * Post or update the starboard entry for `message` given its new star count.
 * No-op if the server has no starboard channel or the count is below threshold.
 */
export async function syncStarboard(
  client: Client,
  db: Database,
  serverConfig: Partial<ServerConfig>,
  message: any,
  serverId: string | null,
  starCount: number
): Promise<void> {
  const channelId = serverConfig.starboardChannelId
  if (!channelId) return

  const threshold = serverConfig.starboardThreshold ?? 1
  const existing = getStarboardEntryByOriginal(db, message.id)

  // Below threshold and not yet posted → nothing to show.
  if (starCount < threshold && !existing) return

  if (existing) {
    await updateCount(client, channelId, existing.starboardMessageId, starCount)
    return
  }

  // First time crossing the threshold — post a fresh entry.
  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null
    if (!channel) {
      logger.warn({ channelId }, 'Starboard: channel not found / not a text channel')
      return
    }
    const jumpUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
    const embed = buildEmbed({
      authorName: message.author?.username ?? 'unknown',
      authorIcon: message.author?.displayAvatarURL?.() ?? null,
      content: message.content ?? '',
      jumpUrl,
      starCount,
    })
    const posted = await channel.send({ embeds: [embed] })
    createStarboardEntry(db, message.id, posted.id, serverId, message.channelId ?? null)
    // Seed a star reaction so members can one-click boost from the starboard.
    try { await posted.react(STAR) } catch { /* non-fatal */ }
    logger.info({ originalMessageId: message.id, starboardMessageId: posted.id, starCount }, 'Starboard: posted entry')
  } catch (error) {
    logger.error({ error, messageId: message.id }, 'Starboard: failed to post entry')
  }
}

/**
 * A star reaction landed on a starboard ENTRY. Route it to the original
 * message's count (deduped per user), then refresh the entry's displayed count.
 * Returns true if this was a starboard entry (i.e. the reaction is fully handled).
 */
export async function handleStarboardStar(
  db: Database,
  entry: StarboardEntry,
  reaction: MessageReaction | PartialMessageReaction,
  reactor: User,
  starCost: number
): Promise<void> {
  const originalId = entry.originalMessageId
  const reactorUser = getOrCreateUser(db, reactor.id, extractDiscordUserInfo(reactor))

  // Can't boost your own elicited message (mirrors the origin-channel guard).
  const tracked = getTrackedMessage(db, originalId)
  if (tracked && reactor.id === tracked.triggerUserDiscordId) return

  // Per-user dedup: one star per (user, original message), wherever they clicked.
  if (hasStarredMessage(db, reactorUser.id, originalId)) return

  // Charge the star cost (0 by default). Skip silently if they can't afford it.
  if (starCost > 0) {
    if (getBalance(db, reactorUser.id).balance < starCost) return
    deductBalanceSimple(db, reactorUser.id, starCost, entry.serverId, 'bounty_star', { messageId: originalId })
  }

  const newCount = recordBountyStar(db, reactorUser.id, originalId, starCost)
  // The entry to refresh IS the reaction's own message (we already hold it).
  try {
    const existing = reaction.message.embeds[0]
    if (existing) {
      await reaction.message.edit({ embeds: [EmbedBuilder.from(existing).setTitle(`${STAR} ${newCount}`)] })
    }
  } catch (error) {
    logger.warn({ error, starboardMessageId: entry.starboardMessageId }, 'Starboard: failed to refresh entry after boost')
  }
  logger.info({ originalMessageId: originalId, reactorId: reactor.id, newCount }, 'Starboard: boosted via entry')
}
