const { Api } = require('telegram');
const bigInt = require('big-integer');
const db = require('./database');
const EventEmitter = require('events');

function parseTitle(rawTitle) {
  if (!rawTitle) return null;
  // Remove extension
  const title = rawTitle.replace(/\.[^/.]+$/, "");
  
  let seriesTitle = "";
  let season = null;
  let episode = null;

  // Patterns with Season AND Episode
  const fullPatterns = [
    // s01e01, S1.E1, S01 E01, Season 1 Episode 1
    /(.*?)(?:season|עונה|s)\s*[-_.]?\s*(\d+)\s*[-_.]?\s*(?:episode|פרק|פ|e|ep|ep\.)\s*[-_.]?\s*(\d+)(.*)/i,
    // 01x01
    /(.*?)(?:\s|[-_.])(\d{1,2})\s*x\s*(\d{1,3})(.*)/i,
    // ע01 פ01
    /(.*?)(?:ע)\s*[-_.]?\s*(\d+)\s*[-_.]?\s*(?:פ)\s*[-_.]?\s*(\d+)(.*)/i,
  ];

  for (const regex of fullPatterns) {
    const match = title.match(regex);
    if (match) {
      seriesTitle = match[1].replace(/[-_.\s]+$/, "").trim();
      season = parseInt(match[2], 10);
      episode = parseInt(match[3], 10);
      break;
    }
  }

  // Fallback: Pattern with Episode only
  if (season === null || episode === null) {
    const epOnlyPatterns = [
      /(.*?)(?:episode|ep|פרק|e)\s*[-_.]?\s*(\d+)(.*)/i,
    ];
    for (const regex of epOnlyPatterns) {
      const match = title.match(regex);
      if (match) {
        seriesTitle = match[1].replace(/[-_.\s]+$/, "").trim();
        season = 1; // Default to season 1
        episode = parseInt(match[2], 10);
        break;
      }
    }
  }

  if (season !== null && episode !== null) {
    if (!seriesTitle || seriesTitle === "") seriesTitle = "Unknown Series";
    
    // Clean up seriesTitle (e.g., replace dots/underscores with spaces)
    seriesTitle = seriesTitle.replace(/[._]/g, " ").trim();
    // Capitalize words
    seriesTitle = seriesTitle.replace(/\b\w/g, l => l.toUpperCase());

    return { seriesTitle, season, episode };
  }

  return null; // Not parsed correctly
}

class Indexer extends EventEmitter {
  constructor(client, messageCache) {
    super();
    this.client = client;
    this.messageCache = messageCache; // To pre-fill cache for streaming
    
    // Per-source indexing state: sourceId -> { status, processed, total, error }
    this.sourceStates = new Map();

    // Global queue for indexing jobs to avoid flooding Telegram client
    this.queue = [];
    this.isProcessingQueue = false;
  }

  getState(sourceId) {
    return this.sourceStates.get(sourceId) || { status: 'idle', processed: 0, total: 0, error: null };
  }

  getAllStates() {
    return this.sourceStates;
  }

  _setState(sourceId, patch) {
    const current = this.sourceStates.get(sourceId) || { status: 'idle', processed: 0, total: 0, error: null };
    const next = { ...current, ...patch };
    this.sourceStates.set(sourceId, next);
    this.emit('progress', sourceId, next);
  }

  async indexSource(source) {
    // If already in queue or actively indexing this source, skip
    const existing = this.sourceStates.get(source.id);
    if (existing && (existing.status === 'indexing' || existing.status === 'queued')) {
      console.log(`[Indexer] Source ${source.name} is already queued or indexing – skipping duplicate request.`);
      return;
    }

    // Mark as queued immediately
    this._setState(source.id, { status: 'queued', error: null });
    this.queue.push(source);
    this._processQueue();
  }

  async _processQueue() {
    if (this.isProcessingQueue || this.queue.length === 0) return;
    this.isProcessingQueue = true;

    while (this.queue.length > 0) {
      const source = this.queue.shift();
      try {
        await this._doIndex(source);
      } catch (e) {
        console.error(`[Indexer] Uncaught error indexing ${source.name}:`, e);
      }
    }

    this.isProcessingQueue = false;
  }

  async _doIndex(source) {
    console.log(`[Indexer] Starting index for source: ${source.name} (${source.link})`);
    // Transition from queued to indexing
    this._setState(source.id, { status: 'indexing', processed: 0, total: 0, error: null });
    
    let channelName = null;
    try {
      const url = new URL(source.link);
      const parts = url.pathname.split('/').filter(Boolean);
      
      if (parts[0] === 'c') {
        const internalId = parts[1];
        if (!internalId) throw new Error('Missing internal channel ID in /c/ link');
        const fullChannelId = '-100' + internalId;
        await this.client.getEntity(bigInt(fullChannelId));
        channelName = fullChannelId;
      } else {
        channelName = parts[0];
        if (!channelName) throw new Error('Missing channel name in link');
        await this.client.getEntity(channelName);
      }
    } catch(e) {
      console.error(`[Indexer] Failed to resolve channel for source ${source.name}:`, e.message);
      this._setState(source.id, { status: 'error', error: e.message });
      return;
    }

    console.log(`[Indexer] Starting index for channel ${channelName}.`);

    const channelArg = channelName.startsWith('-100') ? bigInt(channelName) : channelName;
    let offsetId = 0;
    const limit = 100;
    let hasMore = true;
    let totalIndexed = 0;
    let skipped = 0;

    // Helper to check if message is already indexed without loading everything into memory
    const checkStmt = db.db.prepare('SELECT 1 FROM episodes WHERE message_id = ? AND channel = ?');

    try {
      while (hasMore) {
        hasMore = false;
        const allMsgs = await this.client.getMessages(channelArg, {
            limit,
            offsetId,
        });
        
        // Filter and sort
        const messages = allMsgs.filter(m => m.media && m.media.document).sort((a, b) => b.id - a.id);
        
        // Process in smaller sub-batches with transactions and yielding
        const SUB_BATCH_SIZE = 10;
        for (let i = 0; i < messages.length; i += SUB_BATCH_SIZE) {
          const subBatch = messages.slice(i, i + SUB_BATCH_SIZE);
          
          // Wrap sub-batch in a transaction for performance
          db.db.transaction(() => {
            for (const msg of subBatch) {
              hasMore = true;
              offsetId = msg.id; 

              if (!msg.media?.document) continue;

              // Check if already indexed
              const isIndexed = checkStmt.get(msg.id, channelName);
              if (isIndexed) {
                skipped++;
                continue;
              }

              const doc = msg.media.document;
              const attributes = doc.attributes || [];

              let fileName = `file_${msg.id}`;
              let duration = 0;
              let isVideo = doc.mimeType?.startsWith('video/') || false;
              let isAudio = doc.mimeType?.startsWith('audio/') || false;

              for (const attr of attributes) {
                if (attr.className === 'DocumentAttributeFilename') fileName = attr.fileName;
                if (attr.className === 'DocumentAttributeVideo') { duration = attr.duration; isVideo = true; }
                if (attr.className === 'DocumentAttributeAudio') { duration = attr.duration; isAudio = true; }
              }

              let parsed = parseTitle(fileName);
              if (source.is_single_series) {
                if (!parsed) {
                  parsed = { seriesTitle: source.name, season: 0, episode: msg.id };
                } else {
                  parsed.seriesTitle = source.name;
                }
              } else {
                if (!parsed) {
                  parsed = { seriesTitle: `${source.name} - Other Videos`, season: 0, episode: msg.id };
                }
              }

              if (parsed) {
                // Preload into cache
                const cacheKey = `${channelName}_${msg.id}`;
                if (!this.messageCache.has(cacheKey)) {
                  this.messageCache.set(cacheKey, {
                    message: msg, document: doc,
                    fileSize: Number(doc.size),
                    mimeType: doc.mimeType || 'video/mp4',
                  });
                }

                // Insert into database
                const seriesId = db.getOrCreateSeries(source.id, parsed.seriesTitle);
                const seasonId = db.getOrCreateSeason(seriesId, parsed.season);
                
                db.upsertEpisode(seasonId, parsed.episode, {
                  title: fileName,
                  duration: duration,
                  size: Number(doc.size),
                  message_id: msg.id,
                  channel: channelName,
                  file_name: fileName,
                  mime_type: doc.mimeType || 'video/mp4',
                  is_video: isVideo,
                  is_audio: isAudio
                });
                totalIndexed++;
              }
            }
          })();

          // Update progress after each sub-batch
          this._setState(source.id, { 
            status: 'indexing', 
            processed: totalIndexed + skipped, 
            total: totalIndexed + skipped + (hasMore ? limit : 0) 
          });

          // Yield to event loop to keep the process responsive
          await new Promise(r => setImmediate(r));
        }

        if (hasMore) {
          // Extra wait to avoid Telegram flood bans
          await new Promise(r => setTimeout(r, 200));
        }
      }

      console.log(`[Indexer] Finished indexing ${source.name}. New: ${totalIndexed}, Skipped (cached): ${skipped}.`);
      this._setState(source.id, { status: 'done', processed: totalIndexed + skipped, total: totalIndexed + skipped, error: null });

    } catch (e) {
      console.error(`[Indexer] Error during indexing ${source.name}:`, e.message);
      this._setState(source.id, { status: 'error', processed: totalIndexed, total: totalIndexed + skipped, error: e.message });
      return;
    }

    // Download photo at the end to avoid blocking series appearance
    try {
      if (!source.photo_base64) {
        const entity = await this.client.getEntity(channelArg);
        if (entity && entity.photo) {
          const photoBuffer = await this.client.downloadProfilePhoto(entity, { isBig: false });
          if (photoBuffer && photoBuffer.length > 0) {
            const b64 = photoBuffer.toString('base64');
            db.updateSourcePhoto(source.id, `data:image/jpeg;base64,${b64}`);
          }
        }
      }
    } catch (e) {
      console.error('[Indexer] Could not download photo at end:', e.message);
    }
  }

  async runAll() {
    const sources = db.getSources();
    for (const source of sources) {
      await this.indexSource(source);
    }
  }
}

module.exports = Indexer;
