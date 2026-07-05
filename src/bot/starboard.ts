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
  deleteStarboardEntry,
  type StarboardEntry,
} from '../services/starboard.js'
import { hasStarredMessage, recordBountyStar } from '../services/bounty.js'
import { getOrCreateUser, extractDiscordUserInfo } from '../services/user.js'
import { getBalance, deductBalanceSimple } from '../services/balance.js'
import type { MessageGroup } from '../services/tracking.js'
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
/** Fetch every chunk of a group and stitch them into one author/content/jump. */
async function assembleGroup(
  client: Client,
  group: MessageGroup
): Promise<{ authorName: string; authorIcon: string | null; content: string; jumpUrl: string } | null> {
  try {
    const channel = (await client.channels.fetch(group.channelId)) as TextChannel | null
    if (!channel) return null
    const parts: string[] = []
    let root: any = null
    for (const id of group.memberIds) {
      const m = await channel.messages.fetch(id).catch(() => null)
      if (m) {
        if (!root) root = m
        if (m.content) parts.push(m.content)
      }
    }
    if (!root) return null
    return {
      authorName: root.author?.username ?? 'unknown',
      authorIcon: root.author?.displayAvatarURL?.() ?? null,
      content: parts.join('\n'),
      jumpUrl: `https://discord.com/channels/${root.guildId}/${root.channelId}/${root.id}`,
    }
  } catch {
    return null
  }
}

/**
 * Post or update the single starboard entry for a message GROUP (all chunks of
 * one response), keyed by the group's root id. No-op below threshold.
 */
export async function syncStarboardGroup(
  client: Client,
  db: Database,
  serverConfig: Partial<ServerConfig>,
  group: MessageGroup,
  serverId: string | null,
  starCount: number
): Promise<void> {
  const channelId = serverConfig.starboardChannelId
  if (!channelId) return

  const threshold = serverConfig.starboardThreshold ?? 1
  const existing = getStarboardEntryByOriginal(db, group.rootId)

  // Below threshold and not yet posted → nothing to show.
  if (starCount < threshold && !existing) return

  if (existing) {
    await updateCount(client, channelId, existing.starboardMessageId, starCount)
    return
  }

  // First time crossing the threshold — assemble the whole message and post.
  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null
    if (!channel) {
      logger.warn({ channelId }, 'Starboard: channel not found / not a text channel')
      return
    }
    const assembled = await assembleGroup(client, group)
    if (!assembled) {
      logger.warn({ rootId: group.rootId }, 'Starboard: could not assemble group content')
      return
    }
    const embed = buildEmbed({ ...assembled, starCount })
    const posted = await channel.send({ embeds: [embed] })
    createStarboardEntry(db, group.rootId, posted.id, serverId, group.channelId)
    try { await posted.react(STAR) } catch { /* non-fatal */ }
    logger.info({ rootId: group.rootId, parts: group.memberIds.length, starboardMessageId: posted.id, starCount }, 'Starboard: posted entry')
  } catch (error) {
    logger.error({ error, rootId: group.rootId }, 'Starboard: failed to post entry')
  }
}

/**
 * A star was removed from a message (or its starboard entry) — reflect the new
 * count on the entry, or delete the entry entirely if it fell below threshold.
 */
export async function removeOrUpdateStarboard(
  client: Client,
  db: Database,
  serverConfig: Partial<ServerConfig>,
  originalMessageId: string,
  newCount: number
): Promise<void> {
  const channelId = serverConfig.starboardChannelId
  if (!channelId) return
  const entry = getStarboardEntryByOriginal(db, originalMessageId)
  if (!entry) return

  const threshold = serverConfig.starboardThreshold ?? 1
  if (newCount >= threshold && newCount > 0) {
    await updateCount(client, channelId, entry.starboardMessageId, newCount)
    return
  }

  // Fell below threshold → remove the showcase entry.
  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null
    if (channel) {
      const msg = await channel.messages.fetch(entry.starboardMessageId).catch(() => null)
      if (msg) await msg.delete().catch(() => {})
    }
  } catch (error) {
    logger.warn({ error, starboardMessageId: entry.starboardMessageId }, 'Starboard: failed to delete entry')
  }
  deleteStarboardEntry(db, originalMessageId)
  logger.info({ originalMessageId, newCount }, 'Starboard: removed entry (below threshold)')
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
