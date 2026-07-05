/**
 * SQLite Schema Definition
 */

export const SCHEMA = `
-- Users (Discord users we know about)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  discord_id TEXT UNIQUE NOT NULL,
  username TEXT,
  display_name TEXT,
  avatar_hash TEXT,
  last_seen TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Global user balances (shared across all servers)
CREATE TABLE IF NOT EXISTS balances (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  amount REAL NOT NULL DEFAULT 50,
  last_regen_at TEXT DEFAULT (datetime('now'))
);

-- Servers (Discord guilds) - for reward config and role multipliers
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  discord_id TEXT UNIQUE NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Bot costs (per-server overrides possible)
CREATE TABLE IF NOT EXISTS bot_costs (
  id TEXT PRIMARY KEY,
  bot_discord_id TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id),
  base_cost REAL NOT NULL,
  description TEXT,
  UNIQUE (bot_discord_id, server_id)
);

-- Role configurations (per-server, affects cost multipliers)
CREATE TABLE IF NOT EXISTS role_configs (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  role_discord_id TEXT NOT NULL,
  regen_multiplier REAL DEFAULT 1.0,
  max_balance_override REAL,
  cost_multiplier REAL DEFAULT 1.0,
  priority INTEGER NOT NULL DEFAULT 0,
  UNIQUE (server_id, role_discord_id)
);

-- Transactions (audit log)
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  timestamp TEXT DEFAULT (datetime('now')),
  server_id TEXT REFERENCES servers(id),
  type TEXT NOT NULL,
  from_user_id TEXT REFERENCES users(id),
  to_user_id TEXT REFERENCES users(id),
  bot_discord_id TEXT,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  metadata TEXT DEFAULT '{}'
);

-- Tracked messages (for reaction rewards/tips)
-- Messages are tracked for 7 days after bot response
-- Reactions on either the bot response (message_id) OR the trigger message (trigger_message_id) reward the user
CREATE TABLE IF NOT EXISTS tracked_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id),
  bot_discord_id TEXT NOT NULL,
  trigger_user_id TEXT NOT NULL REFERENCES users(id),
  trigger_message_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Reward claims (prevents same user from rewarding same message multiple times)
CREATE TABLE IF NOT EXISTS reward_claims (
  user_id TEXT NOT NULL REFERENCES users(id),
  message_id TEXT NOT NULL,
  claimed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, message_id)
);

-- User server roles cache (tracks which roles users have in which servers)
-- Used for global regen rate calculation (best role follows you everywhere)
CREATE TABLE IF NOT EXISTS user_server_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  server_id TEXT NOT NULL REFERENCES servers(id),
  role_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of Discord role IDs
  last_seen TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, server_id)
);

-- User preferences (DM opt-in, welcome status)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  dm_opt_in INTEGER NOT NULL DEFAULT 0,
  welcomed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- User notifications (in-app inbox for when DMs are disabled)
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
);

-- Global configuration (runtime-configurable settings)
-- Single row table - only one row with id='global'
CREATE TABLE IF NOT EXISTS global_config (
  id TEXT PRIMARY KEY DEFAULT 'global',
  reward_cooldown_minutes INTEGER NOT NULL DEFAULT 5,
  max_daily_rewards INTEGER NOT NULL DEFAULT 3,
  global_cost_multiplier REAL NOT NULL DEFAULT 1.0,
  modified_by TEXT,
  modified_at TEXT DEFAULT (datetime('now'))
);

-- Insert default global config if not exists
INSERT OR IGNORE INTO global_config (id) VALUES ('global');

-- Daily reward tracking per user
-- Tracks how many free rewards a user has given today
CREATE TABLE IF NOT EXISTS user_daily_rewards (
  discord_id TEXT PRIMARY KEY,
  rewards_today INTEGER NOT NULL DEFAULT 0,
  last_reward_at TEXT,
  reset_date TEXT NOT NULL DEFAULT (date('now'))
);

-- Daily transfer tracking per user
-- Tracks how much ichor a user has sent/received via transfers and tips per day
CREATE TABLE IF NOT EXISTS user_daily_transfers (
  discord_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('sent', 'received')),
  amount_today REAL NOT NULL DEFAULT 0,
  reset_date TEXT NOT NULL DEFAULT (date('now')),
  PRIMARY KEY (discord_id, target_type)
);

-- Bounty system: tracks star counts and tier payouts per message
CREATE TABLE IF NOT EXISTS message_bounties (
  message_id TEXT PRIMARY KEY,
  star_count INTEGER NOT NULL DEFAULT 0,
  tiers_claimed TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Bounty system: tracks individual star contributions (who starred what)
CREATE TABLE IF NOT EXISTS bounty_stars (
  user_id TEXT NOT NULL REFERENCES users(id),
  message_id TEXT NOT NULL,
  cost_paid REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, message_id)
);

-- Starboard: maps a starred (original) message to its posted entry in the
-- starboard channel, so the entry can be updated and re-stars on the entry can
-- be routed back to the original message's star count.
CREATE TABLE IF NOT EXISTS starboard_entries (
  original_message_id TEXT PRIMARY KEY,
  starboard_message_id TEXT NOT NULL,
  server_id TEXT,
  channel_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_starboard_by_post ON starboard_entries(starboard_message_id);

-- Cost overrides (temporary sales/discounts)
CREATE TABLE IF NOT EXISTS cost_overrides (
  id TEXT PRIMARY KEY,
  bot_discord_id TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id),
  override_cost REAL NOT NULL,
  original_cost REAL NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Bot sleeps (pinned .sleep messages with scheduled unpinning)
-- Source of truth for the pin is the Discord message; this table persists the
-- expiry timer + unpin bookkeeping across soma restarts.
CREATE TABLE IF NOT EXISTS bot_sleeps (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  channel_id TEXT NOT NULL,
  bot_name TEXT NOT NULL,       -- chapterx botId (EMS directory name)
  message_id TEXT NOT NULL,      -- pinned .sleep message id
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,      -- hard cap even when messages-only; drives the sweeper
  messages_initial INTEGER,      -- NULL when time-only
  created_by TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (server_id, channel_id, bot_name)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_transactions_from_user ON transactions(from_user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_transactions_to_user ON transactions(to_user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_transactions_server ON transactions(server_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type, timestamp);
CREATE INDEX IF NOT EXISTS idx_bot_costs_bot ON bot_costs(bot_discord_id);
CREATE INDEX IF NOT EXISTS idx_role_configs_server ON role_configs(server_id);
-- NOTE: the priority index is created by migration 014, NOT here. SCHEMA runs
-- before migrations, so on an existing DB the priority column does not exist
-- yet at this point; indexing it here would crash startup (no such column).
CREATE INDEX IF NOT EXISTS idx_tracked_messages_expires ON tracked_messages(expires_at);
-- Note: idx_tracked_messages_trigger is created by migration 009
CREATE INDEX IF NOT EXISTS idx_notifications_user ON user_notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bounty_stars_message ON bounty_stars(message_id);
CREATE INDEX IF NOT EXISTS idx_cost_overrides_bot ON cost_overrides(bot_discord_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_cost_overrides_server ON cost_overrides(server_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_bot_sleeps_expires ON bot_sleeps(expires_at);
CREATE INDEX IF NOT EXISTS idx_bot_sleeps_lookup ON bot_sleeps(server_id, channel_id, bot_name);
`
