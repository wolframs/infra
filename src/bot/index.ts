/**
 * Infra Discord Bot - Entry Point
 * 
 * This bot handles:
 * - User commands (/balance, /transfer, /costs, /history)
 * - Admin commands (/soma grant, /soma set-cost, etc.)
 * - Reaction watching for rewards and tips
 * - DM notifications (including insufficient funds from API)
 */

import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js'
import type { Database } from 'better-sqlite3'
import type { InfraEventBus } from '../types/events.js'
import { registerCommands, handleInteraction } from './commands/index.js'
import { handleReactionAdd, handleReactionRemove } from './handlers/reactions.js'
import { setupNotificationHandlers } from './handlers/notifications.js'
import { logAdminConfig } from '../services/roles.js'
import { logger } from '../utils/logger.js'
import { initPinCache, markPinsDirty, getPinnedMessages } from '../infra/pin-cache.js'

/** Discord intents and partials needed for infra bot functionality */
const CLIENT_OPTIONS = {
  intents: [
    GatewayIntentBits.Guilds,              // Basic guild info
    GatewayIntentBits.GuildMessages,        // Track bot messages
    GatewayIntentBits.GuildMessageReactions, // Watch reactions
    GatewayIntentBits.GuildMembers,         // Get member roles for multipliers
    GatewayIntentBits.DirectMessages,       // Send DM notifications
    GatewayIntentBits.MessageContent,       // Read message content (privileged)
  ],
  partials: [
    Partials.Message,   // Reactions on uncached messages
    Partials.Reaction,  // Partial reaction data
    Partials.Channel,   // DM channels
  ],
}

export class InfraBot {
  private client: Client
  private db: Database
  private token: string
  private eventBus?: InfraEventBus

  constructor(db: Database, token: string, eventBus?: InfraEventBus) {
    this.db = db
    this.token = token
    this.eventBus = eventBus
    this.client = new Client(CLIENT_OPTIONS)

    initPinCache()
    this.setupEventHandlers()
  }

  private setupEventHandlers(): void {
    // Ready event
    this.client.once(Events.ClientReady, (readyClient) => {
      logger.info({
        user: readyClient.user.tag,
        guildCount: readyClient.guilds.cache.size,
      }, 'Infra bot connected to Discord')

      // Set activity
      readyClient.user.setActivity('the loom', { type: ActivityType.Watching })

      // Set up notification handlers for API events (insufficient funds, etc.)
      if (this.eventBus) {
        setupNotificationHandlers(this.eventBus, this.client, this.db)
      }
    })

    // Interaction events (commands, buttons, modals)
    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        await handleInteraction(interaction, this.db, this.client)
      } catch (error) {
        logger.error({ error }, 'Error handling interaction')
      }
    })

    // Message events — fork thread auto-renaming
    this.client.on(Events.MessageCreate, async (message) => {
      try {
        // Auto-rename fork threads when a new message arrives
        // Fork threads have names ending with ⌥
        if (
          message.channel.isThread() &&
          message.channel.name.endsWith('⌥') &&
          !message.system
        ) {
          // Only rename if the new message is from a different author than the previous
          const recent = await message.channel.messages.fetch({ before: message.id, limit: 1 })
          const prev = recent.first()
          if (!prev || prev.author.id !== message.author.id) {
            const clean = message.content
              .replace(/<@!?\d+>/g, '')
              .replace(/<#\d+>/g, '')
              .replace(/```[\s\S]*?```/g, '')
              .trim()
            if (clean) {
              const newName = '⌥ ' + clean.slice(0, 40) + '...'
              await message.channel.setName(newName.slice(0, 100))
            }
          }
        }
      } catch (error) {
        // Non-critical — just log and move on
        logger.debug({ error, channelId: message.channel.id }, 'Failed to auto-rename fork thread')
      }

      // Auto-pin .steer messages (and unpin previous .steer for same bot)
      // Only pin if author has "Scribe" role (matches ChapterX steer_roles check)
      try {
        if (message.content.startsWith('.steer') && !message.author.bot) {
          const memberRoles = message.member?.roles.cache.map(r => r.name) ?? []
          logger.info({ author: message.author.username, roles: memberRoles, hasMember: !!message.member }, '.steer detected — checking roles')
          if (!memberRoles.some((r: string) => r.toLowerCase() === 'scribe')) {
            logger.info({ author: message.author.username, roles: memberRoles }, '.steer ignored — author lacks Scribe role')
          } else {
            // Extract just the bot name (first word) for unpin matching
            const steerLine = message.content.split('\n')[0]!.slice('.steer'.length).trim().toLowerCase()
            const botName = steerLine.split(/\s+/)[0] ?? ''
            logger.info({ steerLine, botName, contentPreview: message.content.slice(0, 80) }, '.steer parsed bot name')
            if (botName) {
              // Pin first, then try to unpin old ones (non-blocking)
              logger.info({ channelId: message.channel.id, botName, author: message.author.username }, 'Attempting to pin .steer message')
              await message.pin()
              markPinsDirty(message.channel.id)
              logger.info({ channelId: message.channel.id, botName, author: message.author.username }, 'Auto-pinned .steer message')

              // Unpin old .steer for same bot — fire and forget with timeout
              const unpinOld = async () => {
                try {
                  const pinnedMessages = await getPinnedMessages(message.channel)
                  if (!pinnedMessages) return

                  for (const [, pinned] of pinnedMessages) {
                    if (pinned.content.startsWith('.steer') && pinned.id !== message.id) {
                      const pinnedLine = pinned.content.split('\n')[0]!.slice('.steer'.length).trim().toLowerCase()
                      const pinnedBotName = pinnedLine.split(/\s+/)[0] ?? ''
                      if (pinnedBotName === botName) {
                        await pinned.unpin()
                        logger.info({ messageId: pinned.id, botName }, 'Unpinned old .steer for same bot')
                      }
                    }
                  }
                  markPinsDirty(message.channel.id)
                } catch (err) {
                  logger.warn({ err, channelId: message.channel.id }, 'Failed to unpin old .steer pins')
                }
              }
              // 5s timeout — if cache miss + API hangs, we just move on
              Promise.race([unpinOld(), new Promise(r => setTimeout(r, 5000))]).catch(() => {})
            }
          }
        }
      } catch (error: any) {
        logger.warn({ error: error?.message || error, channelId: message.channel.id }, 'Failed to auto-pin .steer message')
      }
    })

    // Pin change events — invalidate pin cache so next read re-fetches
    this.client.on(Events.ChannelPinsUpdate, (channel) => {
      markPinsDirty(channel.id)
    })

    // Reaction events
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      try {
        await handleReactionAdd(reaction, user, this.db, this.client)
      } catch (error) {
        logger.error({ error }, 'Error handling reaction')
      }
    })

    this.client.on(Events.MessageReactionRemove, async (reaction, user) => {
      try {
        await handleReactionRemove(reaction, user, this.db, this.client)
      } catch (error) {
        logger.error({ error }, 'Error handling reaction removal')
      }
    })

    // Error handling
    this.client.on(Events.Error, (error) => {
      logger.error({ error }, 'Discord client error')
    })

    this.client.on(Events.Warn, (message) => {
      logger.warn({ message }, 'Discord client warning')
    })
  }

  async start(): Promise<void> {
    logger.info('Starting Infra Discord bot...')

    // Log admin configuration for verification
    logAdminConfig()

    // Register slash commands
    await registerCommands(this.token)

    // Login to Discord
    await this.client.login(this.token)
  }

  async stop(): Promise<void> {
    logger.info('Stopping Infra Discord bot...')
    this.client.destroy()
  }

  get discordClient(): Client {
    return this.client
  }
}


