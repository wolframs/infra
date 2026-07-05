/**
 * Reaction Event Handler
 * 
 * Handles messageReactionAdd events for rewards and tips
 */

import {
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type Client,
} from 'discord.js'
import type { Database } from 'better-sqlite3'
import { getTrackedMessage, getTrackedMessageByTrigger } from '../../services/tracking.js'
import { addBalance, transferBalance, getBalance, deductBalanceSimple } from '../../services/balance.js'
import { getOrCreateUser, getServerById, extractDiscordUserInfo } from '../../services/user.js'
import { hasClaimedReward, recordRewardClaim } from '../../services/rewards.js'
import { hasStarredMessage, recordBountyStar, removeBountyStar, getMessageBounty, getNewlyUnlockedTiers, markTiersClaimed } from '../../services/bounty.js'
import { getStarboardEntryByPost } from '../../services/starboard.js'
import { syncStarboard, handleStarboardStar, removeOrUpdateStarboard } from '../starboard.js'
import { isDmOptedIn } from '../../services/preferences.js'
import { notifyTipReceived, notifyBountyEarned } from '../../services/notifications.js'
import { createTipReceivedEmbed, createBountyEarnedEmbed } from '../embeds/builders.js'
import { sendDM, createViewMessageButton } from '../notifications/dm.js'
import { getGlobalConfig } from '../../services/config.js'
import { checkTransferLimits, recordTransfer } from '../../services/transfer-limits.js'
import { DEFAULT_BOUNTY_TIERS } from '../../types/index.js'
import { logger } from '../../utils/logger.js'
import { getTodayDateStringPST } from '../../utils/timezone.js'

/** Default reward emoji */
const DEFAULT_REWARD_EMOJI = ['🔥']

/** Default tip emoji */
const DEFAULT_TIP_EMOJI = '🫀'

/** Default reward amount */
const DEFAULT_REWARD_AMOUNT = 1

/** Default tip amount */
const DEFAULT_TIP_AMOUNT = 5

/** Default bounty emoji */
const DEFAULT_BOUNTY_EMOJI = '⭐'

/** Default bounty star cost */
const DEFAULT_BOUNTY_STAR_COST = 50

/** Database reference for reward tracking */
let rewardDb: Database | null = null

/**
 * Set the database reference for reward tracking
 */
export function setRewardDatabase(db: Database): void {
  rewardDb = db
}

/**
 * Get today's date string in YYYY-MM-DD format (PST timezone)
 * Daily rewards reset at midnight PST, not UTC.
 */
function getTodayDateString(): string {
  return getTodayDateStringPST()
}

/**
 * Get or create a user's daily reward tracking record
 * Automatically resets if the date has changed
 */
function getUserDailyRewardInfo(discordUserId: string): {
  rewardsToday: number
  lastRewardAt: Date | null
} {
  if (!rewardDb) {
    return { rewardsToday: 0, lastRewardAt: null }
  }

  const today = getTodayDateString()

  // Try to get existing record
  const row = rewardDb.prepare(`
    SELECT rewards_today, last_reward_at, reset_date
    FROM user_daily_rewards WHERE discord_id = ?
  `).get(discordUserId) as { rewards_today: number; last_reward_at: string | null; reset_date: string } | undefined

  if (!row) {
    return { rewardsToday: 0, lastRewardAt: null }
  }

  // If the reset date is not today, the count should be treated as 0
  if (row.reset_date !== today) {
    return { rewardsToday: 0, lastRewardAt: row.last_reward_at ? new Date(row.last_reward_at) : null }
  }

  return {
    rewardsToday: row.rewards_today,
    lastRewardAt: row.last_reward_at ? new Date(row.last_reward_at) : null,
  }
}

/**
 * Record that a user gave a reward
 */
function recordUserReward(discordUserId: string): void {
  if (!rewardDb) return

  const today = getTodayDateString()

  // Upsert the record
  rewardDb.prepare(`
    INSERT INTO user_daily_rewards (discord_id, rewards_today, last_reward_at, reset_date)
    VALUES (?, 1, datetime('now'), ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      rewards_today = CASE 
        WHEN reset_date = ? THEN rewards_today + 1 
        ELSE 1 
      END,
      last_reward_at = datetime('now'),
      reset_date = ?
  `).run(discordUserId, today, today, today)
}

/**
 * Get the user's reward status including cooldown and daily limit
 */
export function getUserRewardStatus(discordUserId: string): {
  rewardsUsedToday: number
  maxDailyRewards: number
  rewardsRemaining: number
  cooldownRemainingSeconds: number
  canReward: boolean
  nextRewardAt: Date | null
} {
  const config = getGlobalConfig()
  const { rewardsToday, lastRewardAt } = getUserDailyRewardInfo(discordUserId)

  const maxDaily = config.maxDailyRewards
  // When maxDaily is 0, it means unlimited - use Infinity for remaining
  const remaining = maxDaily === 0 ? Infinity : Math.max(0, maxDaily - rewardsToday)

  // Calculate cooldown
  let cooldownRemainingSeconds = 0
  let nextRewardAt: Date | null = null

  if (lastRewardAt && config.rewardCooldownMinutes > 0) {
    const cooldownMs = config.rewardCooldownMinutes * 60 * 1000
    const elapsed = Date.now() - lastRewardAt.getTime()
    const remainingMs = cooldownMs - elapsed

    if (remainingMs > 0) {
      cooldownRemainingSeconds = Math.ceil(remainingMs / 1000)
      nextRewardAt = new Date(lastRewardAt.getTime() + cooldownMs)
    }
  }

  // User can reward if they have remaining rewards AND are not on cooldown
  const canReward = remaining > 0 && cooldownRemainingSeconds === 0

  return {
    rewardsUsedToday: rewardsToday,
    maxDailyRewards: maxDaily,
    rewardsRemaining: remaining,
    cooldownRemainingSeconds,
    canReward,
    nextRewardAt: cooldownRemainingSeconds > 0 ? nextRewardAt : null,
  }
}

/**
 * Check if a user can give a reward (for backward compatibility)
 */
export function isUserOnRewardCooldown(discordUserId: string): boolean {
  return !getUserRewardStatus(discordUserId).canReward
}

/**
 * Get the remaining cooldown for a user in seconds (for backward compatibility)
 */
export function getUserRewardCooldownRemaining(discordUserId: string): number {
  return getUserRewardStatus(discordUserId).cooldownRemainingSeconds
}

export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  db: Database,
  client: Client
): Promise<void> {
  // Ignore bot reactions
  if (user.bot) return

  try {
    // Fetch partials if needed
    if (reaction.partial) {
      await reaction.fetch()
    }
    if (reaction.message.partial) {
      await reaction.message.fetch()
    }
    if (user.partial) {
      await user.fetch()
    }
  } catch (error) {
    logger.error({ error }, 'Failed to fetch reaction/message partials')
    return
  }

  const messageId = reaction.message.id
  const emoji = reaction.emoji.name

  if (!emoji) return

  // Starboard entries are not tracked messages of their own; intercept a star
  // ON an entry and route it back to the original message's count (deduped).
  const starEntry = getStarboardEntryByPost(db, messageId)
  if (starEntry) {
    const sbServer = starEntry.serverId ? getServerById(db, starEntry.serverId) : null
    const sbConfig = sbServer?.config
    const sbBountyEmoji = sbConfig?.bountyEmoji || DEFAULT_BOUNTY_EMOJI
    if (emoji === sbBountyEmoji) {
      await handleStarboardStar(
        db,
        starEntry,
        reaction,
        user as User,
        sbConfig?.bountyStarCost ?? DEFAULT_BOUNTY_STAR_COST
      )
    }
    return
  }

  // Check if this is a tracked bot message OR a trigger message
  // First try looking up by bot response message ID
  let tracked = getTrackedMessage(db, messageId)
  
  // If not found, check if this is the trigger message that caused a bot response
  if (!tracked) {
    tracked = getTrackedMessageByTrigger(db, messageId)
  }
  
  if (!tracked) return

  // Get server config (tracked.serverId is the internal UUID, not Discord ID)
  const server = tracked.serverId
    ? getServerById(db, tracked.serverId)
    : null

  const serverConfig = server?.config || {
    rewardEmoji: DEFAULT_REWARD_EMOJI,
    rewardAmount: DEFAULT_REWARD_AMOUNT,
    tipEmoji: DEFAULT_TIP_EMOJI,
    tipAmount: DEFAULT_TIP_AMOUNT,
    bountyEmoji: DEFAULT_BOUNTY_EMOJI,
    bountyStarCost: DEFAULT_BOUNTY_STAR_COST,
    bountyTiers: DEFAULT_BOUNTY_TIERS,
  }

  // Get bounty config with defaults
  const bountyEmoji = serverConfig.bountyEmoji || DEFAULT_BOUNTY_EMOJI
  const bountyStarCost = serverConfig.bountyStarCost ?? DEFAULT_BOUNTY_STAR_COST
  const bountyTiers = serverConfig.bountyTiers || DEFAULT_BOUNTY_TIERS

  logger.debug({
    messageId,
    emoji,
    reactorId: user.id,
    triggerUserId: tracked.triggerUserDiscordId,
    isBounty: emoji === bountyEmoji,
    isTip: emoji === serverConfig.tipEmoji,
    isReward: serverConfig.rewardEmoji.includes(emoji),
  }, 'Processing reaction on tracked message')

  // Check for bounty star (paid reaction)
  if (emoji === bountyEmoji) {
    await processBounty(
      db,
      client,
      user as User,
      tracked.triggerUserId,
      tracked.triggerUserDiscordId,
      tracked.serverId,
      bountyStarCost,
      bountyTiers,
      reaction.message,
      serverConfig
    )
    return
  }

  // Reward and tip flow ichor to the trigger user, so the trigger user can't
  // claim them on their own elicited message. (Stars are a rating/showcase, not
  // a self-reward — handled above — so the summoner MAY star to nominate.)
  if (user.id === tracked.triggerUserDiscordId) return

  // Check for tip
  if (emoji === serverConfig.tipEmoji) {
    await processTip(
      db,
      client,
      user as User,
      tracked.triggerUserId,
      tracked.triggerUserDiscordId,
      tracked.serverId,
      serverConfig.tipAmount,
      reaction.message
    )
    return
  }

  // Check for reward
  if (serverConfig.rewardEmoji.includes(emoji)) {
    await processReward(
      db,
      user as User,
      tracked.triggerUserId,
      tracked.serverId,
      serverConfig.rewardAmount,
      emoji,
      tracked.messageId  // Always use canonical bot response ID for claim tracking
    )
  }
}

/**
 * Handle a removed reaction. Only stars are reversible (they're a live count);
 * reward/tip are minting/transfers and are not undone on un-react. Removing a
 * star decrements the message's count and updates — or deletes — its starboard
 * entry when it drops below threshold.
 */
export async function handleReactionRemove(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  db: Database,
  client: Client
): Promise<void> {
  if (user.bot) return

  try {
    if (reaction.partial) await reaction.fetch()
    if (user.partial) await user.fetch()
  } catch (error) {
    logger.error({ error }, 'Failed to fetch reaction/user partials (remove)')
    return
  }

  const messageId = reaction.message.id
  const emoji = reaction.emoji.name
  if (!emoji) return

  // Un-star on a starboard entry → drop the reactor's star from the original.
  const starEntry = getStarboardEntryByPost(db, messageId)
  if (starEntry) {
    const sbServer = starEntry.serverId ? getServerById(db, starEntry.serverId) : null
    const sbConfig = sbServer?.config
    if (emoji === (sbConfig?.bountyEmoji || DEFAULT_BOUNTY_EMOJI)) {
      const reactorUser = getOrCreateUser(db, (user as User).id, extractDiscordUserInfo(user as User))
      const newCount = removeBountyStar(db, reactorUser.id, starEntry.originalMessageId)
      if (newCount !== null) {
        await removeOrUpdateStarboard(client, db, sbConfig || {}, starEntry.originalMessageId, newCount)
      }
    }
    return
  }

  // Un-star on a tracked (original) message.
  let tracked = getTrackedMessage(db, messageId)
  if (!tracked) tracked = getTrackedMessageByTrigger(db, messageId)
  if (!tracked) return

  const server = tracked.serverId ? getServerById(db, tracked.serverId) : null
  const serverConfig = server?.config
  if (emoji !== (serverConfig?.bountyEmoji || DEFAULT_BOUNTY_EMOJI)) return

  const reactorUser = getOrCreateUser(db, (user as User).id, extractDiscordUserInfo(user as User))
  const newCount = removeBountyStar(db, reactorUser.id, messageId)
  if (newCount !== null) {
    await removeOrUpdateStarboard(client, db, serverConfig || {}, messageId, newCount)
  }
}

async function processTip(
  db: Database,
  client: Client,
  tipper: User,
  recipientUserId: string,
  recipientDiscordId: string,
  serverId: string | null,
  tipAmount: number,
  message: any
): Promise<void> {
  // Ensure tipper exists and cache their profile
  const tipperUser = getOrCreateUser(db, tipper.id, extractDiscordUserInfo(tipper))

  // Check tipper has enough balance
  const tipperBalance = getBalance(db, tipperUser.id)
  if (tipperBalance.balance < tipAmount) {
    logger.debug({
      tipperId: tipper.id,
      required: tipAmount,
      available: tipperBalance.balance,
    }, 'Tipper has insufficient balance for tip')
    return
  }

  // Check daily transfer limits (tips count as transfers)
  const limitCheck = checkTransferLimits(db, tipper.id, recipientDiscordId, tipAmount)
  if (!limitCheck.allowed) {
    logger.debug({
      tipperId: tipper.id,
      recipientId: recipientDiscordId,
      amount: tipAmount,
      reason: limitCheck.reason,
      senderRemaining: limitCheck.senderRemaining,
      receiverRemaining: limitCheck.receiverRemaining,
    }, 'Tip blocked by daily transfer limit')
    return
  }

  try {
    // Transfer ichor from tipper to recipient
    const result = transferBalance(
      db,
      tipperUser.id,
      recipientUserId,
      tipAmount,
      serverId || '',
      `Tip for message ${message.id}`
    )

    // Record the tip against daily transfer limits
    recordTransfer(db, tipper.id, recipientDiscordId, tipAmount)

    // Get recipient Discord user
    const recipient = await client.users.fetch(recipientDiscordId)
    const channel = message.channel

    // Build message URL
    const messageUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
    const channelName = channel.name || 'channel'

    // Check if recipient has opted into DMs
    const dmOptedIn = isDmOptedIn(db, recipientUserId)
    let dmSent = false

    if (dmOptedIn) {
      // DM recipient about the tip with View Message button
      const embed = createTipReceivedEmbed(
        tipper.tag,
        tipAmount,
        channelName,
        result.toBalanceAfter,
        messageUrl
      )

      // Add View Message button if we have the guild/channel/message IDs
      const viewMessageButton = message.guildId && message.channelId && message.id
        ? createViewMessageButton(message.guildId, message.channelId, message.id)
        : undefined

      dmSent = await sendDM(recipient, {
        embeds: [embed],
        components: viewMessageButton ? [viewMessageButton] : [],
      })

      if (dmSent) {
        logger.debug({
          recipientId: recipientDiscordId,
          amount: tipAmount,
        }, 'Sent tip received DM')
      }
    }

    // If DMs not enabled or failed, store notification in inbox
    if (!dmSent) {
      notifyTipReceived(
        db,
        recipientUserId,
        tipper.tag,
        tipAmount,
        channelName,
        messageUrl
      )
      
      logger.debug({
        recipientId: recipientUserId,
        dmOptedIn,
      }, 'Stored tip notification in inbox')
    }

    logger.info({
      tipperId: tipper.id,
      recipientId: recipientDiscordId,
      amount: tipAmount,
      messageId: message.id,
      notificationMethod: dmSent ? 'dm' : 'inbox',
    }, 'Tip processed successfully')

  } catch (error: any) {
    logger.error({
      error,
      tipperId: tipper.id,
      recipientId: recipientDiscordId,
    }, 'Failed to process tip')
  }
}

async function processBounty(
  db: Database,
  client: Client,
  reactor: User,
  recipientUserId: string,
  recipientDiscordId: string,
  serverId: string | null,
  starCost: number,
  tiers: { threshold: number; reward: number }[],
  message: any,
  serverConfig: any
): Promise<void> {
  // Get reactor's internal user ID and cache their profile
  const reactorUser = getOrCreateUser(db, reactor.id, extractDiscordUserInfo(reactor))
  const messageId = message.id

  // Check if user has already starred this message
  if (hasStarredMessage(db, reactorUser.id, messageId)) {
    logger.debug({
      reactorId: reactor.id,
      messageId,
    }, 'User has already starred this message')
    return
  }

  // Check reactor has enough balance for the star cost
  const reactorBalance = getBalance(db, reactorUser.id)
  if (reactorBalance.balance < starCost) {
    logger.debug({
      reactorId: reactor.id,
      required: starCost,
      available: reactorBalance.balance,
    }, 'Reactor has insufficient balance for bounty star')
    return
  }

  try {
    // Deduct star cost from reactor (goes to void - deflationary)
    deductBalanceSimple(db, reactorUser.id, starCost, serverId, 'bounty_star', {
      messageId,
      recipientUserId,
    })

    // Record the star and get new count
    const newStarCount = recordBountyStar(db, reactorUser.id, messageId, starCost)

    logger.info({
      reactorId: reactor.id,
      recipientUserId,
      messageId,
      starCost,
      newStarCount,
    }, 'Bounty star recorded')

    // Showcase on the starboard (posts a new entry or bumps the count).
    await syncStarboard(client, db, serverConfig, message, serverId, newStarCount)

    // Check if any tier thresholds are crossed
    const currentBounty = getMessageBounty(db, messageId)
    if (!currentBounty) return

    const newlyUnlocked = getNewlyUnlockedTiers(
      newStarCount,
      currentBounty.tiersClaimed,
      tiers
    )

    if (newlyUnlocked.length === 0) {
      logger.debug({
        messageId,
        starCount: newStarCount,
        tiersClaimed: currentBounty.tiersClaimed,
      }, 'No new tiers unlocked')
      return
    }

    // Calculate total reward from newly unlocked tiers
    let totalReward = 0
    for (const tierIndex of newlyUnlocked) {
      totalReward += tiers[tierIndex].reward
    }

    // Mark tiers as claimed
    markTiersClaimed(db, messageId, newlyUnlocked)

    // Add bounty reward to recipient
    const result = addBalance(
      db,
      recipientUserId,
      totalReward,
      serverId,
      'reward',
      {
        type: 'bounty',
        messageId,
        starCount: newStarCount,
        tiersUnlocked: newlyUnlocked,
        tierRewards: newlyUnlocked.map(i => tiers[i]),
      }
    )

    logger.info({
      recipientUserId,
      messageId,
      totalReward,
      newBalance: result.balanceAfter,
      starCount: newStarCount,
      tiersUnlocked: newlyUnlocked,
    }, 'Bounty tier reward(s) paid out')

    // Notify recipient about the bounty
    const recipient = await client.users.fetch(recipientDiscordId)
    const channel = message.channel
    const messageUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
    const channelName = channel.name || 'channel'

    // Check if recipient has opted into DMs
    const dmOptedIn = isDmOptedIn(db, recipientUserId)
    let dmSent = false

    if (dmOptedIn) {
      const embed = createBountyEarnedEmbed(
        totalReward,
        newStarCount,
        channelName,
        result.balanceAfter,
        messageUrl
      )

      const viewMessageButton = message.guildId && message.channelId && message.id
        ? createViewMessageButton(message.guildId, message.channelId, message.id)
        : undefined

      dmSent = await sendDM(recipient, {
        embeds: [embed],
        components: viewMessageButton ? [viewMessageButton] : [],
      })
    }

    // If DMs not enabled or failed, store notification in inbox
    if (!dmSent) {
      notifyBountyEarned(
        db,
        recipientUserId,
        totalReward,
        newStarCount,
        channelName,
        messageUrl
      )
    }

  } catch (error: any) {
    logger.error({
      error,
      reactorId: reactor.id,
      recipientUserId,
      messageId,
    }, 'Failed to process bounty star')
  }
}

async function processReward(
  db: Database,
  reactor: User,
  recipientUserId: string,
  serverId: string | null,
  rewardAmount: number,
  emoji: string,
  messageId: string
): Promise<void> {
  // Get reactor's internal user ID for permanent tracking and cache their profile
  const reactorUser = getOrCreateUser(db, reactor.id, extractDiscordUserInfo(reactor))

  // Check if user has already rewarded this message (permanent check - one reward per message per user)
  if (hasClaimedReward(db, reactorUser.id, messageId)) {
    logger.debug({
      reactorId: reactor.id,
      messageId,
    }, 'Reward already claimed for this message')
    return
  }

  // Check daily limit and cooldown
  const rewardStatus = getUserRewardStatus(reactor.id)
  
  if (rewardStatus.rewardsRemaining <= 0) {
    logger.debug({
      reactorId: reactor.id,
      messageId,
      rewardsUsedToday: rewardStatus.rewardsUsedToday,
      maxDaily: rewardStatus.maxDailyRewards,
    }, 'User has used all daily rewards')
    return
  }

  if (rewardStatus.cooldownRemainingSeconds > 0) {
    logger.debug({
      reactorId: reactor.id,
      messageId,
      cooldownRemaining: rewardStatus.cooldownRemainingSeconds,
    }, 'User on reward cooldown')
    return
  }

  try {
    // Record the reward claim permanently (before granting, for atomicity)
    recordRewardClaim(db, reactorUser.id, messageId)

    // Add reward to recipient (rewards are free for the reactor)
    const result = addBalance(
      db,
      recipientUserId,
      rewardAmount,
      serverId,
      'reward',
      { emoji, messageId, reactorId: reactor.id }
    )

    // Record that this user gave a reward AFTER success (updates daily count and cooldown timestamp)
    recordUserReward(reactor.id)

    // Get updated status to log
    const updatedStatus = getUserRewardStatus(reactor.id)
    
    logger.info({
      reactorId: reactor.id,
      recipientUserId,
      amount: rewardAmount,
      emoji,
      messageId,
      newBalance: result.balanceAfter,
      rewardsUsedToday: updatedStatus.rewardsUsedToday,
      rewardsRemaining: updatedStatus.rewardsRemaining,
    }, 'Reward processed successfully')

    // Rewards are silent - no DM notification (too noisy)

  } catch (error: any) {
    logger.error({
      error,
      reactorId: reactor.id,
      recipientUserId,
    }, 'Failed to process reward')
  }
}

/**
 * Cleanup old reward tracking entries (call periodically)
 * Removes entries older than 7 days to keep the table small
 */
export function cleanupRewardCooldowns(): void {
  if (!rewardDb) return

  try {
    const result = rewardDb.prepare(`
      DELETE FROM user_daily_rewards 
      WHERE reset_date < date('now', '-7 days')
    `).run()

    if (result.changes > 0) {
      logger.debug({ cleaned: result.changes }, 'Cleaned up old reward tracking entries')
    }
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup reward tracking entries')
  }
}

