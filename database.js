const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'catalog.db');
const db = new Database(dbPath);

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    link TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, link)
  );

  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
    title TEXT NOT NULL,
    FOREIGN KEY(source_id) REFERENCES sources(id)
  );
  
  CREATE INDEX IF NOT EXISTS idx_series_source_title ON series(source_id, title);

  CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER,
    season_number INTEGER NOT NULL,
    FOREIGN KEY(series_id) REFERENCES series(id)
  );

  CREATE INDEX IF NOT EXISTS idx_seasons_series_seasons ON seasons(series_id, season_number);

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER,
    episode_number INTEGER NOT NULL,
    title TEXT,
    duration INTEGER,
    size INTEGER,
    message_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    file_name TEXT,
    mime_type TEXT,
    is_video INTEGER DEFAULT 0,
    is_audio INTEGER DEFAULT 0,
    FOREIGN KEY(season_id) REFERENCES seasons(id)
  );
  
  CREATE INDEX IF NOT EXISTS idx_episodes_season_episode ON episodes(season_id, episode_number);
  CREATE INDEX IF NOT EXISTS idx_episodes_msg_channel ON episodes(message_id, channel);

  CREATE TABLE IF NOT EXISTS watch_progress (
    user_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    progress_seconds INTEGER DEFAULT 0,
    duration INTEGER DEFAULT 0,
    is_watched INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, episode_id),
    FOREIGN KEY(episode_id) REFERENCES episodes(id)
  );

  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, item_type, item_id)
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    auto_next_enabled INTEGER DEFAULT 1,
    auto_next_countdown INTEGER DEFAULT 15,
    seek_step INTEGER DEFAULT 15
  );
`);

try {
  db.exec('ALTER TABLE sources ADD COLUMN photo_base64 TEXT');
} catch (e) {}

try {
  db.exec('ALTER TABLE sources ADD COLUMN is_single_series INTEGER DEFAULT 1');
} catch (e) {}

try {
  db.exec('ALTER TABLE sources ADD COLUMN user_id INTEGER');
} catch (e) {}

try {
  db.exec('ALTER TABLE user_settings ADD COLUMN seek_step INTEGER DEFAULT 15');
} catch (e) {}

try {
  db.exec('ALTER TABLE episodes ADD COLUMN is_manual INTEGER DEFAULT 0');
  db.exec('ALTER TABLE episodes ADD COLUMN original_season_id INTEGER');
  db.exec('ALTER TABLE episodes ADD COLUMN original_episode_number INTEGER');
} catch (e) {}

/**
 * Maintenance: Merge duplicate series, seasons, and episodes.
 * This can be slow on large databases, so it's best to run once 
 * at startup or triggered via API, rather than on every require.
 */
function runMaintenance() {
  console.log('[Database] Starting maintenance (merging duplicates)...');
  const start = Date.now();
  
  // 1. Merge duplicate series for single-series sources
  const singleSources = db.prepare('SELECT id, name FROM sources WHERE is_single_series = 1').all();
  for (const src of singleSources) {
    const seriesRows = db.prepare('SELECT id, title FROM series WHERE source_id = ?').all(src.id);
    if (seriesRows.length > 1) {
      console.log(`[Database] Merging ${seriesRows.length} series for single-series source "${src.name}" (ID: ${src.id})...`);
      const primary = seriesRows[0];
      const others = seriesRows.slice(1);

      for (const other of others) {
        db.prepare('UPDATE seasons SET series_id = ? WHERE series_id = ?').run(primary.id, other.id);
        db.prepare("UPDATE OR IGNORE favorites SET item_id = ? WHERE item_id = ? AND item_type = 'series'").run(primary.id, other.id);
        db.prepare("DELETE FROM favorites WHERE item_id = ? AND item_type = 'series'").run(other.id);
        db.prepare('DELETE FROM series WHERE id = ?').run(other.id);
      }
      db.prepare('UPDATE series SET title = ? WHERE id = ?').run(src.name, primary.id);
      mergeDuplicateSeasons(primary.id);
    }
  }
  
  // 2. Scan ALL series for duplicate seasons
  const allSeries = db.prepare('SELECT id FROM series').all();
  for (const s of allSeries) {
    mergeDuplicateSeasons(s.id);
  }
  
  // 3. Scan ALL seasons for duplicate episodes
  const allSeasons = db.prepare('SELECT id FROM seasons').all();
  for (const s of allSeasons) {
     deduplicateEpisodes(s.id);
  }
  
  console.log(`[Database] Maintenance complete in ${Date.now() - start}ms.`);
}

function mergeDuplicateSeasons(seriesId) {
  const seasons = db.prepare('SELECT id, season_number FROM seasons WHERE series_id = ?').all(seriesId);
  const byNumber = {};
  for (const s of seasons) {
    if (!byNumber[s.season_number]) byNumber[s.season_number] = [];
    byNumber[s.season_number].push(s);
  }

  for (const num in byNumber) {
    const group = byNumber[num];
    if (group.length > 1) {
      console.log(`[Database] Merging ${group.length} rows for Season ${num} in Series ${seriesId}...`);
      const primary = group[0];
      const others = group.slice(1);

      for (const other of others) {
        // Move episodes to primary season
        db.prepare('UPDATE episodes SET season_id = ? WHERE season_id = ?').run(primary.id, other.id);
        // Delete the extra season row
        db.prepare('DELETE FROM seasons WHERE id = ?').run(other.id);
      }
      
      // Cleanup duplicate episodes in this season (same message_id + channel)
      deduplicateEpisodes(primary.id);
    }
  }
}

function deduplicateEpisodes(seasonId) {
  // 1. Deduplicate by message_id + channel (exact same message indexed multiple times)
  const msgDups = db.prepare(`
    SELECT message_id, channel, COUNT(*) as count 
    FROM episodes 
    WHERE season_id = ? 
    GROUP BY message_id, channel 
    HAVING count > 1
  `).all(seasonId);

  for (const d of msgDups) {
    const rows = db.prepare('SELECT id FROM episodes WHERE season_id = ? AND message_id = ? AND channel = ?').all(seasonId, d.message_id, d.channel);
    mergeEpisodes(rows);
  }

  // 2. Deduplicate by episode_number (same episode number in one season, e.g. from different messages)
  const numDups = db.prepare(`
    SELECT episode_number, COUNT(*) as count 
    FROM episodes 
    WHERE season_id = ? AND episode_number > 0
    GROUP BY episode_number 
    HAVING count > 1
  `).all(seasonId);

  for (const d of numDups) {
    const rows = db.prepare('SELECT id FROM episodes WHERE season_id = ? AND episode_number = ?').all(seasonId, d.episode_number);
    mergeEpisodes(rows);
  }
}

function mergeEpisodes(rows) {
  if (rows.length <= 1) return;
  const primaryId = rows[0].id;
  const others = rows.slice(1);
  for (const other of others) {
    // Move watch progress to primary if it doesn't exist
    db.prepare('UPDATE OR IGNORE watch_progress SET episode_id = ? WHERE episode_id = ?').run(primaryId, other.id);
    db.prepare('DELETE FROM watch_progress WHERE episode_id = ?').run(other.id);
    
    // Move favorites
    db.prepare("UPDATE OR IGNORE favorites SET item_id = ? WHERE item_id = ? AND item_type = 'episode'").run(primaryId, other.id);
    db.prepare("DELETE FROM favorites WHERE item_id = ? AND item_type = 'episode'").run(other.id);

    db.prepare('DELETE FROM episodes WHERE id = ?').run(other.id);
  }
}


module.exports = {
  db,
  runMaintenance,
  
  // Sources
  addSource(name, link, isSingleSeries = true, userId = null) {
    try {
      const stmt = db.prepare('INSERT INTO sources (user_id, name, link, is_single_series) VALUES (?, ?, ?, ?)');
      const info = stmt.run(userId, name, link, isSingleSeries ? 1 : 0);
      return { id: info.lastInsertRowid, user_id: userId, name, link, is_single_series: isSingleSeries ? 1 : 0 };
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('Source link already exists for this user');
      }
      throw e;
    }
  },
  
  getSources(userId = null) {
    if (userId !== null) {
      return db.prepare('SELECT * FROM sources WHERE user_id = ?').all(userId);
    }
    return db.prepare('SELECT * FROM sources').all();
  },
  
  deleteSource(id) {
    // Delete watch progress for episodes belonging to this source
    db.prepare(`
      DELETE FROM watch_progress 
      WHERE episode_id IN (
        SELECT id FROM episodes WHERE season_id IN (
          SELECT id FROM seasons WHERE series_id IN (
            SELECT id FROM series WHERE source_id = ?
          )
        )
      )
    `).run(id);

    // Delete favorites for episodes belonging to this source
    db.prepare(`
      DELETE FROM favorites 
      WHERE item_type = 'episode' AND item_id IN (
        SELECT id FROM episodes WHERE season_id IN (
          SELECT id FROM seasons WHERE series_id IN (
            SELECT id FROM series WHERE source_id = ?
          )
        )
      )
    `).run(id);

    // Delete favorites for series belonging to this source
    db.prepare(`
      DELETE FROM favorites 
      WHERE item_type = 'series' AND item_id IN (
        SELECT id FROM series WHERE source_id = ?
      )
    `).run(id);

    db.prepare('DELETE FROM episodes WHERE season_id IN (SELECT id FROM seasons WHERE series_id IN (SELECT id FROM series WHERE source_id = ?))').run(id);
    db.prepare('DELETE FROM seasons WHERE series_id IN (SELECT id FROM series WHERE source_id = ?)').run(id);
    db.prepare('DELETE FROM series WHERE source_id = ?').run(id);
    const stmt = db.prepare('DELETE FROM sources WHERE id = ?');
    stmt.run(id);
  },

  getSourceByLink(link, userId = null) {
    if (userId !== null) {
      return db.prepare('SELECT * FROM sources WHERE link = ? AND user_id = ?').get(link, userId);
    }
    return db.prepare('SELECT * FROM sources WHERE link = ?').get(link);
  },

  getSourceById(id) {
    return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  },
  
  updateSourcePhoto(id, photo_base64) {
    db.prepare('UPDATE sources SET photo_base64 = ? WHERE id = ?').run(photo_base64, id);
  },

  setSourcesForUser(userId, sourcesList) {
    const existing = db.prepare('SELECT * FROM sources WHERE user_id = ?').all(userId);
    const existingLinks = new Set(existing.map(s => s.link));
    const newLinks = new Set(sourcesList.map(s => s.link));

    // Delete sources that are no longer in the new list
    for (const src of existing) {
      if (!newLinks.has(src.link)) {
        this.deleteSource(src.id);
      }
    }

    const inserted = [];
    for (const src of sourcesList) {
      if (!existingLinks.has(src.link)) {
        try {
          const info = db.prepare('INSERT INTO sources (user_id, name, link, is_single_series) VALUES (?, ?, ?, ?)').run(
            userId, src.name, src.link, src.is_single_series === 1 || src.is_single_series === true ? 1 : 0
          );
          inserted.push({ id: info.lastInsertRowid, user_id: userId, name: src.name, link: src.link, is_single_series: src.is_single_series });
        } catch (e) {
          if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE') { 
            console.error('Error inserting source from sync', e);
          }
        }
      } else {
        // Update name and single_series flag for existing
        db.prepare('UPDATE sources SET name = ?, is_single_series = ? WHERE link = ? AND user_id = ?').run(
          src.name, src.is_single_series === 1 || src.is_single_series === true ? 1 : 0, src.link, userId
        );
      }
    }
    return inserted;
  },

   // Catalog insertions
  getOrCreateSeries(sourceId, title) {
    // For single-series sources, we only want ONE series entry.
    const src = db.prepare('SELECT name, is_single_series FROM sources WHERE id = ?').get(sourceId);
    if (src && src.is_single_series === 1) {
      let row = db.prepare('SELECT id FROM series WHERE source_id = ?').get(sourceId);
      if (row) return row.id;
      // If not exists, use the source name as title
      const info = db.prepare('INSERT INTO series (source_id, title) VALUES (?, ?)').run(sourceId, src.name);
      return info.lastInsertRowid;
    }

    let row = db.prepare('SELECT id FROM series WHERE source_id = ? AND title = ?').get(sourceId, title);
    if (!row) {
      const info = db.prepare('INSERT INTO series (source_id, title) VALUES (?, ?)').run(sourceId, title);
      return info.lastInsertRowid;
    }
    return row.id;
  },

  getOrCreateSeason(seriesId, seasonNumber) {
    let row = db.prepare('SELECT id FROM seasons WHERE series_id = ? AND season_number = ?').get(seriesId, seasonNumber);
    if (!row) {
      const info = db.prepare('INSERT INTO seasons (series_id, season_number) VALUES (?, ?)').run(seriesId, seasonNumber);
      return info.lastInsertRowid;
    }
    return row.id;
  },

  upsertEpisode(seasonId, episodeNumber, data) {
    let row = db.prepare('SELECT id, is_manual FROM episodes WHERE message_id = ? AND channel = ?').get(data.message_id, data.channel);
    if (!row) {
      db.prepare(`
        INSERT INTO episodes (season_id, episode_number, title, duration, size, message_id, channel, file_name, mime_type, is_video, is_audio, is_manual, original_season_id, original_episode_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        seasonId, episodeNumber, data.title, data.duration, data.size, data.message_id, 
        data.channel, data.file_name, data.mime_type, data.is_video ? 1 : 0, data.is_audio ? 1 : 0,
        seasonId, episodeNumber
      );
    } else {
      if (!row.is_manual) {
        db.prepare(`
          UPDATE episodes SET season_id = ?, episode_number = ?, title = ?, duration = ?, size = ?, file_name = ?, mime_type = ?, is_video = ?, is_audio = ?, original_season_id = ?, original_episode_number = ?
          WHERE id = ?
        `).run(
          seasonId, episodeNumber, data.title, data.duration, data.size,
          data.file_name, data.mime_type, data.is_video ? 1 : 0, data.is_audio ? 1 : 0,
          seasonId, episodeNumber,
          row.id
        );
      } else {
        db.prepare(`
          UPDATE episodes SET title = ?, duration = ?, size = ?, file_name = ?, mime_type = ?, is_video = ?, is_audio = ?, original_season_id = ?, original_episode_number = ?
          WHERE id = ?
        `).run(
          data.title, data.duration, data.size,
          data.file_name, data.mime_type, data.is_video ? 1 : 0, data.is_audio ? 1 : 0,
          seasonId, episodeNumber,
          row.id
        );
      }
    }
  },

  // Get all message_ids already indexed for a channel (for deduplication)
  getIndexedMessageIds(channelName) {
    const rows = db.prepare('SELECT message_id FROM episodes WHERE channel = ?').all(channelName);
    return rows.map(r => r.message_id);
  },

  // Catalog Queries
  getAllSeries(userId = null) {
    if (userId !== null) {
      return db.prepare(`
        SELECT series.*, sources.photo_base64 as source_photo, 
               CASE WHEN sources.is_single_series = 1 THEN sources.name ELSE series.title END as title
        FROM series 
        JOIN sources ON series.source_id = sources.id 
        WHERE sources.user_id = ?
        ORDER BY title ASC
      `).all(userId);
    }
    return db.prepare(`
      SELECT series.*, sources.photo_base64 as source_photo,
             CASE WHEN sources.is_single_series = 1 THEN sources.name ELSE series.title END as title 
      FROM series 
      JOIN sources ON series.source_id = sources.id 
      ORDER BY title ASC
    `).all();
  },

  getSeriesById(id, userId = null) {
    if (userId !== null) {
      return db.prepare(`
        SELECT series.*, sources.photo_base64 as source_photo,
               CASE WHEN sources.is_single_series = 1 THEN sources.name ELSE series.title END as title
        FROM series 
        JOIN sources ON series.source_id = sources.id 
        WHERE series.id = ? AND sources.user_id = ?
      `).get(id, userId);
    }
    return db.prepare(`
      SELECT series.*, sources.photo_base64 as source_photo,
             CASE WHEN sources.is_single_series = 1 THEN sources.name ELSE series.title END as title
      FROM series 
      JOIN sources ON series.source_id = sources.id
      WHERE series.id = ?
    `).get(id);
  },

  getSeasonsBySeriesId(seriesId) {
    return db.prepare(`
      SELECT seasons.*, COUNT(episodes.id) as episode_count 
      FROM seasons 
      LEFT JOIN episodes ON seasons.id = episodes.season_id 
      WHERE seasons.series_id = ? 
      GROUP BY seasons.id 
      ORDER BY seasons.season_number ASC
    `).all(seriesId);
  },

  getEpisodesBySeasonId(seasonId) {
    return db.prepare('SELECT * FROM episodes WHERE season_id = ? ORDER BY episode_number ASC').all(seasonId);
  },

  // User Settings
  getUserSettings(userId) {
    let settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
    if (!settings) {
      db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(userId);
      settings = { user_id: userId, auto_next_enabled: 1, auto_next_countdown: 15, seek_step: 15 };
    }
    return settings;
  },
  
  updateUserSettings(userId, autoNextEnabled, autoNextCountdown, seekStep) {
    db.prepare(`
      INSERT INTO user_settings (user_id, auto_next_enabled, auto_next_countdown, seek_step) 
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET 
      auto_next_enabled = excluded.auto_next_enabled,
      auto_next_countdown = excluded.auto_next_countdown,
      seek_step = excluded.seek_step
    `).run(userId, autoNextEnabled ? 1 : 0, autoNextCountdown, seekStep || 15);
  },

  // Watch Progress
  updateProgress(userId, episodeId, progressSeconds, duration, isWatched) {
    db.prepare(`
      INSERT INTO watch_progress (user_id, episode_id, progress_seconds, duration, is_watched, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, episode_id) DO UPDATE SET
      progress_seconds = excluded.progress_seconds,
      duration = excluded.duration,
      is_watched = excluded.is_watched,
      updated_at = excluded.updated_at
    `).run(userId, episodeId, progressSeconds, duration, isWatched ? 1 : 0);
  },

  getProgress(userId, episodeId) {
    return db.prepare('SELECT * FROM watch_progress WHERE user_id = ? AND episode_id = ?').get(userId, episodeId);
  },

  getAllProgress(userId) {
    return db.prepare('SELECT * FROM watch_progress WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  },

  // Favorites
  addFavorite(userId, itemType, itemId) {
    db.prepare('INSERT OR IGNORE INTO favorites (user_id, item_type, item_id) VALUES (?, ?, ?)').run(userId, itemType, itemId);
  },

  removeFavorite(userId, itemType, itemId) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_type = ? AND item_id = ?').run(userId, itemType, itemId);
  },

  getFavorites(userId) {
    return db.prepare('SELECT * FROM favorites WHERE user_id = ? ORDER BY added_at DESC').all(userId);
  }
};
