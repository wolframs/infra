/**
 * Database Migrations
 * 
 * Handles schema updates for existing databases.
 * Each migration runs once and is tracked in the schema_migrations table.
 */

import type { Database } from 'better-sqlite3'
import { logger } from '../utils/logger.js'

interface Migration {
  id: string
  description: string
  up: (db: Database) => void
}

/**
 * All migrations in order
 */
const MIGRATIONS: Migration[] = [
  {
    id: '001_add_user_profile_columns',
    description: 'Add username, display_name, avatar_hash, last_seen columns to users table',
    up: (db) => {
      // Check if columns already exist (for fresh databases)
      const tableInfo = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
      const existingColumns = new Set(tableInfo.map(c => c.name))

      if (!existingColumns.has('username')) {
        db.exec(`ALTER TABLE users ADD COLUMN username TEXT`)
      }
      if (!existingColumns.has('display_name')) {
        db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`)
      }
      if (!existingColumns.has('avatar_hash')) {
        db.exec(`ALTER TABLE users ADD COLUMN avatar_hash TEXT`)
      }
      if (!existingColumns.has('last_seen')) {
        db.exec(`ALTER TABLE users ADD COLUMN last_seen TEXT`)
      }
    }
  },
  {
    id: '002_add_user_preferences',
    description: 'Add user_preferences table for DM opt-in and other settings',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          user_id TEXT PRIMARY KEY REFERENCES users(id),
          dm_opt_in INTEGER NOT NULL DEFAULT 0,
          welcomed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `)
    }
  },
  {
    id: '003_add_user_notifications',
    description: 'Add user_notifications table for in-app notification inbox',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          action_hint TEXT,
          action_data TEXT,
          read INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON user_notifications(user_id, read, created_at DESC)`)
    }
  },
  {
    id: '004_add_global_config',
    description: 'Add global_config table for runtime-configurable settings',
    up: (db) => {
      // Create table if it doesn't exist (with old column name for now)
      db.exec(`
        CREATE TABLE IF NOT EXISTS global_config (
          id TEXT PRIMARY KEY DEFAULT 'global',
          reward_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
          global_cost_multiplier REAL NOT NULL DEFAULT 1.0,
          modified_by TEXT,
          modified_at TEXT DEFAULT (datetime('now'))
        )
      `)
      // Insert default row if not exists
      db.exec(`INSERT OR IGNORE INTO global_config (id) VALUES ('global')`)
    }
  },
  {
    id: '005_global_config_rewards_update',
    description: 'Update global_config: rename cooldown to minutes, add max daily rewards',
    up: (db) => {
      // Check current columns
      const tableInfo = db.prepare(`PRAGMA table_info(global_config)`).all() as Array<{ name: string }>
      const existingColumns = new Set(tableInfo.map(c => c.name))

      // SQLite doesn't support RENAME COLUMN in older versions, so we need to check
      // If old column exists, we need to handle the rename
      if (existingColumns.has('reward_cooldown_seconds') && !existingColumns.has('reward_cooldown_minutes')) {
        // Get current value before migration
        const currentRow = db.prepare(`SELECT reward_cooldown_seconds FROM global_config WHERE id = 'global'`).get() as { reward_cooldown_seconds: number } | undefined
        const currentSeconds = currentRow?.reward_cooldown_seconds ?? 60
        // Convert seconds to minutes (round up)
        const currentMinutes = Math.ceil(currentSeconds / 60)

        // Add new column
        db.exec(`ALTER TABLE global_config ADD COLUMN reward_cooldown_minutes INTEGER NOT NULL DEFAULT 5`)
        
        // Copy converted value
        db.prepare(`UPDATE global_config SET reward_cooldown_minutes = ? WHERE id = 'global'`).run(currentMinutes)
        
        // Note: We can't drop the old column in SQLite without recreating the table
        // The old column will remain but be unused - this is fine for SQLite
      }

      // Add max_daily_rewards if it doesn't exist
      if (!existingColumns.has('max_daily_rewards')) {
        db.exec(`ALTER TABLE global_config ADD COLUMN max_daily_rewards INTEGER NOT NULL DEFAULT 3`)
      }
    }
  },
  {
    id: '006_add_user_daily_rewards',
    description: 'Add user_daily_rewards table for tracking free rewards per day',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_daily_rewards (
          discord_id TEXT PRIMARY KEY,
          rewards_today INTEGER NOT NULL DEFAULT 0,
          last_reward_at TEXT,
          reset_date TEXT NOT NULL DEFAULT (date('now'))
        )
      `)
    }
  },
  {
    id: '007_add_base_economy_settings',
    description: 'Add base_regen_rate, max_balance, starting_balance to global_config for runtime configuration',
    up: (db) => {
      const tableInfo = db.prepare(`PRAGMA table_info(global_config)`).all() as Array<{ name: string }>
      const existingColumns = new Set(tableInfo.map(c => c.name))

      // Add base_regen_rate (ichor per hour, default 5)
      if (!existingColumns.has('base_regen_rate')) {
        db.exec(`ALTER TABLE global_config ADD COLUMN base_regen_rate REAL NOT NULL DEFAULT 5.0`)
      }

      // Add max_balance (maximum storable ichor, default 100)
      if (!existingColumns.has('max_balance')) {
        db.exec(`ALTER TABLE global_config ADD COLUMN max_balance REAL NOT NULL DEFAULT 100.0`)
      }

      // Add starting_balance (initial ichor for new users, default 50)
      if (!existingColumns.has('starting_balance')) {
        db.exec(`ALTER TABLE global_config ADD COLUMN starting_balance REAL NOT NULL DEFAULT 50.0`)
      }
    }
  },
  {
    id: '008_add_transfer_limits',
    description: 'Add daily transfer limits (sent/received) to global_config and tracking table',
    up: (db) => {
      // Add columns to global_config
      const tableInfo = db.prepare(`PRAGMA table_info(global_config)`).all() as Array<{ name: string }>
      const existingColumns = new Set(tableInfo.map(c => c.name))

      // Add max_daily_sent (max ichor a user can send per day, default 1000)
      if (!existingColumns.has('max_daily_sent')) {
        db.exec(`ALTER TABLE global_config ADD COLUMN max_daily_sent REAL NOT NULL DEFAULT 1000.0`)
      }

      // Add max_daily_received (max ichor a user can receive per day, default 2000)
      if (!existingColumns.has('max_daily_received')) {
        db.exec(`ALTER TABLE global_config ADD COLUMN max_daily_received REAL NOT NULL DEFAULT 2000.0`)
      }

      // Create tracking table for daily transfers
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_daily_transfers (
          discord_id TEXT NOT NULL,
          target_type TEXT NOT NULL CHECK (target_type IN ('sent', 'received')),
          amount_today REAL NOT NULL DEFAULT 0,
          reset_date TEXT NOT NULL DEFAULT (date('now')),
          PRIMARY KEY (discord_id, target_type)
        )
      `)
    }
  },
  {
    id: '009_add_trigger_message_tracking',
    description: 'Add trigger_message_id to tracked_messages for rewarding reactions on the triggering message',
    up: (db) => {
      const tableInfo = db.prepare(`PRAGMA table_info(tracked_messages)`).all() as Array<{ name: string }>
      const existingColumns = new Set(tableInfo.map(c => c.name))

      // Add trigger_message_id column (nullable - existing records won't have it)
      if (!existingColumns.has('trigger_message_id')) {
        db.exec(`ALTER TABLE tracked_messages ADD COLUMN trigger_message_id TEXT`)
        // Create index for looking up by trigger message
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tracked_messages_trigger ON tracked_messages(trigger_message_id)`)
      }
    }
  },
  {
    id: '010_add_bounty_system',
    description: 'Add bounty system tables for paid star reactions with tiered rewards',
    up: (db) => {
      // Table to track bounty stars on messages
      // star_count: total stars on this message
      // tiers_claimed: JSON array of tier indices that have been paid out (e.g., [0, 1] means tiers 0 and 1 claimed)
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_bounties (
          message_id TEXT PRIMARY KEY,
          star_count INTEGER NOT NULL DEFAULT 0,
          tiers_claimed TEXT NOT NULL DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `)

      // Table to track individual star contributions (who starred what)
      // Prevents double-starring and provides audit trail
      db.exec(`
        CREATE TABLE IF NOT EXISTS bounty_stars (
          user_id TEXT NOT NULL REFERENCES users(id),
          message_id TEXT NOT NULL,
          cost_paid REAL NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, message_id)
        )
      `)

      // Index for looking up all stars on a message
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bounty_stars_message ON bounty_stars(message_id)`)
    }
  },
  {
    id: '011_add_cost_overrides',
    description: 'Add cost_overrides table for temporary sales/discounts on bot costs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cost_overrides (
          id TEXT PRIMARY KEY,
          bot_discord_id TEXT NOT NULL,
          server_id TEXT REFERENCES servers(id),
          override_cost REAL NOT NULL,
          original_cost REAL NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_overrides_bot ON cost_overrides(bot_discord_id, expires_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_overrides_server ON cost_overrides(server_id, expires_at)`)
    }
  },
  {
    id: '012_add_bot_pauses',
    description: 'Add bot_pauses table tracking pinned .pause messages for scheduled unpinning',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bot_pauses (
          id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL REFERENCES servers(id),
          channel_id TEXT NOT NULL,
          bot_name TEXT NOT NULL,
          message_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          messages_initial INTEGER,
          created_by TEXT NOT NULL,
          reason TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE (server_id, channel_id, bot_name)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_pauses_expires ON bot_pauses(expires_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_pauses_lookup ON bot_pauses(server_id, channel_id, bot_name)`)
    }
  },
  {
    id: '013_rename_bot_pauses_to_bot_sleeps',
    description: 'Rename bot_pauses table to bot_sleeps (pause/unpause → sleep/wake)',
    up: (db) => {
      // Schema.ts may have already created an empty bot_sleeps table before
      // this migration runs — drop it so the rename can proceed.
      const hasPauses = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_pauses'`).get()
      if (hasPauses) {
        db.exec(`DROP TABLE IF EXISTS bot_sleeps`)
        db.exec(`ALTER TABLE bot_pauses RENAME TO bot_sleeps`)
      }
      db.exec(`DROP INDEX IF EXISTS idx_bot_pauses_expires`)
      db.exec(`DROP INDEX IF EXISTS idx_bot_pauses_lookup`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_sleeps_expires ON bot_sleeps(expires_at)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_sleeps_lookup ON bot_sleeps(server_id, channel_id, bot_name)`)
    }
  },
  {
    id: '014_add_role_priority',
    description: 'Add priority column to role_configs for precedence-based resolution (highest-priority role wins)',
    up: (db) => {
      // Idempotent column add (fresh databases already get it from schema.ts)
      const tableInfo = db.prepare(`PRAGMA table_info(role_configs)`).all() as Array<{ name: string }>
      const existingColumns = new Set(tableInfo.map(c => c.name))

      if (!existingColumns.has('priority')) {
        // Existing rows default to 0 → identical to the legacy "best role wins" behaviour
        db.exec(`ALTER TABLE role_configs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_role_configs_priority ON role_configs(server_id, priority)`)
    }
  },
  {
    id: '015_add_starboard_entries',
    description: 'Add starboard_entries table mapping starred messages to their starboard posts',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS starboard_entries (
          original_message_id TEXT PRIMARY KEY,
          starboard_message_id TEXT NOT NULL,
          server_id TEXT,
          channel_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_starboard_by_post ON starboard_entries(starboard_message_id)`)
    }
  },
]

/**
 * Initialize migrations table
 */
function initMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `)
}

/**
 * Get list of already applied migrations
 */
function getAppliedMigrations(db: Database): Set<string> {
  const rows = db.prepare(`SELECT id FROM schema_migrations`).all() as Array<{ id: string }>
  return new Set(rows.map(r => r.id))
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database): { applied: string[], skipped: string[] } {
  initMigrationsTable(db)
  
  const applied = getAppliedMigrations(db)
  const result = { applied: [] as string[], skipped: [] as string[] }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      result.skipped.push(migration.id)
      continue
    }

    logger.info({ migrationId: migration.id, description: migration.description }, 'Running migration')

    try {
      // Run migration in a transaction
      const runMigration = db.transaction(() => {
        migration.up(db)
        db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`).run(migration.id)
      })
      runMigration()

      result.applied.push(migration.id)
      logger.info({ migrationId: migration.id }, 'Migration completed')
    } catch (error) {
      logger.error({ migrationId: migration.id, error }, 'Migration failed')
      throw error
    }
  }

  if (result.applied.length > 0) {
    logger.info({ applied: result.applied.length, skipped: result.skipped.length }, 'Migrations complete')
  }

  return result
}

