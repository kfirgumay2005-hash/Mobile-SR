-- A player: a permanent, unique username claimed once by a private id.
CREATE TABLE IF NOT EXISTS players (
	username TEXT PRIMARY KEY, -- lower case, never changes
	uid TEXT NOT NULL UNIQUE,  -- SHA-256 of the player's private id
	created INTEGER NOT NULL
);

-- One row per player and game: that player's best result.
--   done = 1: the game was completed, and value is the time in seconds.
--   done = 0: it was not; level is the level reached and value is the
--             progress made (points, or monsters defeated).
CREATE TABLE IF NOT EXISTS scores (
	game TEXT NOT NULL,
	uid TEXT NOT NULL,
	name TEXT NOT NULL,    -- display name, can be changed freely
	done INTEGER NOT NULL,
	level INTEGER NOT NULL,
	value REAL NOT NULL,
	gear TEXT NOT NULL,    -- weapon, sword or ship used
	at INTEGER NOT NULL,   -- when the best result was set (ms)
	seen INTEGER NOT NULL, -- last submission (ms), for rate limiting
	PRIMARY KEY (game, uid)
);

CREATE INDEX IF NOT EXISTS scores_rank ON scores (game, done, level, value);
