/**
 * Infra Core Type Definitions
 */

// Re-export all types
export * from './db.js'
export * from './api.js'

/**
 * Transaction types for the ledger
 */
export type TransactionType =
  | 'spend'    // Bot activation (mention, reply, m-continue)
  | 'regen'    // Regeneration tick
  | 'transfer' // User-to-user
  | 'reward'   // Reaction reward
  | 'tip'      // Direct tip
  | 'grant'    // Admin grant
  | 'revoke'   // Admin revoke
  | 'refund'   // Failed inference refund

/**
 * Trigger types for bot activations
 */
export type TriggerType = 'mention' | 'reply' | 'm_continue'

/**
 * Bounty tier configuration
 */
export interface BountyTier {
  threshold: number    // Number of stars needed to trigger this tier
  reward: number       // Ichor rewarded to message author when tier is reached
}

/**
 * Server-specific configuration (rewards, tips, bounties)
 */
export interface ServerConfig {
  name?: string              // Discord server name (for display)
  rewardEmoji: string[]      // Emoji that give rewards (can be multiple)
  rewardAmount: number       // Ichor per reward reaction
  tipEmoji: string           // Single emoji for tipping
  tipAmount: number          // Ichor transferred per tip
  // Bounty system
  bountyEmoji?: string       // Single emoji for paid bounty stars (default: '⭐')
  bountyStarCost?: number    // Ichor cost per star reaction (default: 50)
  bountyTiers?: BountyTier[] // Tier thresholds and rewards (default: [{4, 500}, {7, 1500}])
  // Starboard
  starboardChannelId?: string  // Channel where starred messages are showcased (unset = disabled)
  starboardThreshold?: number  // Min star count for a message to appear on the starboard (default: 1)
  lastModifiedBy?: string    // Discord user ID who last modified config
  lastModifiedAt?: string    // ISO timestamp of last modification
}

/**
 * Global configuration values (applies to all users)
 * Some values come from environment (env), others are runtime configurable (db)
 */
export interface GlobalConfig {
  // Environment-configured (defaults, set at startup)
  baseRegenRate: number      // Ichor per hour (default: 5)
  maxBalance: number         // Maximum storable ichor (default: 100)
  startingBalance: number    // Initial ichor for new users (default: 50)
  
  // Runtime-configurable (stored in database, changeable by admins)
  rewardCooldownMinutes: number  // Cooldown between free rewards in minutes (default: 5)
  maxDailyRewards: number        // Max free rewards per user per day (default: 3)
  globalCostMultiplier: number   // Multiplier applied to all bot costs (default: 1.0)
  maxDailySent: number           // Max ichor a user can send per day via transfers/tips (default: 1000)
  maxDailyReceived: number       // Max ichor a user can receive per day via transfers/tips (default: 2000)
}

/**
 * API server configuration
 */
export interface ApiConfig {
  port: number
  serviceTokens: string[]
  databasePath: string
}

/**
 * Default global configuration values
 */
export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  baseRegenRate: 5,
  maxBalance: 100,
  startingBalance: 50,
  rewardCooldownMinutes: 5,
  maxDailyRewards: 3,
  globalCostMultiplier: 1.0,
  maxDailySent: 1000,
  maxDailyReceived: 2000,
}

/**
 * Default bounty tiers
 */
export const DEFAULT_BOUNTY_TIERS: BountyTier[] = [
  { threshold: 4, reward: 500 },
  { threshold: 7, reward: 1500 },
]

/**
 * Default server configuration values
 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  rewardEmoji: ['🔥'],
  rewardAmount: 1,
  tipEmoji: '🫀',
  tipAmount: 5,
  bountyEmoji: '⭐',
  bountyStarCost: 50,
  bountyTiers: DEFAULT_BOUNTY_TIERS,
}
