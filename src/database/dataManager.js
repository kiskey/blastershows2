// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');
const { getTrackers } = require('../utils/trackers');
const config = require('../utils/config');
const fs = require('fs').promises; // Use promises-based fs
const path = require('path');
const { parseTitle, normalizeBaseTitle } = require('../parser/titleParser'); // We need this for the rescue op

const HINTS_FILE_PATH = path.join(__dirname, '..', '..', 'search_hints.json');
const HINTS_KEY = 'search_hints';


/**
 * Loads hints from the JSON file into Redis on startup.
 */
async function loadHintsIntoRedis() {
    try {
        const fileContent = await fs.readFile(HINTS_FILE_PATH, 'utf-8');
        const hints = JSON.parse(fileContent);
        if (Object.keys(hints).length > 0) {
            await redis.hset(HINTS_KEY, hints);
            logger.info(`Successfully loaded ${Object.keys(hints).length} hints into Redis.`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn('search_hints.json not found. Creating an empty one.');
            await fs.writeFile(HINTS_FILE_PATH, '{}', 'utf-8');
        } else {
            logger.error({ err: error }, 'Failed to load search_hints.json');
        }
    }
}

/**
 * Adds a new hint to both Redis and the persistent JSON file.
 * @param {string} title - The normalized title to use as the key.
 * @param {string} id - The TMDb or IMDb ID (e.g., "tmdb:123" or "tt123").
 */
async function addHint(title, id) {
    try {
        // Update Redis immediately for instant use
        await redis.hset(HINTS_KEY, { [title]: id });

        // Update the JSON file for persistence
        const fileContent = await fs.readFile(HINTS_FILE_PATH, 'utf-8');
        const hints = JSON.parse(fileContent);
        hints[title] = id;
        await fs.writeFile(HINTS_FILE_PATH, JSON.stringify(hints, null, 2), 'utf-8');

        logger.info({ title, id }, 'Successfully added/updated search hint.');
        return true;
    } catch (error) {
        logger.error({ err: error }, 'Failed to add search hint.');
        return false;
    }
}

/**
 * Gets a hint from the Redis cache.
 * @param {string} title - The normalized title.
 * @returns {Promise<string|null>} The TMDb or IMDb ID.
 */
async function getHint(title) {
    return redis.hget(HINTS_KEY, title);
}

// SCHEMA:
// imdb_map:{imdbId} -> tmdbId
// show_map:{baseTitle}:{year} -> tmdbId (CACHE)
// stream:tmdb:{tmdbId} -> HASH
// catalog:series -> Sorted Set

async function findOrCreateShow(tmdbId, imdbId, baseTitle, year) {
    const imdbMappingKey = `imdb_map:${imdbId}`;
    const titleMappingKey = year ? `show_map:${baseTitle}:${year}` : `show_map:${baseTitle}`;

    const pipeline = redis.pipeline();
    pipeline.set(imdbMappingKey, tmdbId);
    pipeline.set(titleMappingKey, tmdbId, 'EX', 60 * 60 * 24 * 30); // Cache title mapping for 30 days
    await pipeline.exec();

    logger.debug({ imdbId, tmdbId, title: baseTitle }, 'Created/refreshed ID mappings.');
}

async function addStream(tmdbId, streamInfo) {
    const { infoHash, name, resolution, languages, size, episodes, season: parsedSeason } = streamInfo;
    if (!parsedSeason && episodes.length === 0) {
        logger.warn({ tmdbId, name }, "Could not add stream: No season or episode info could be parsed.");
        return;
    }
    const season = parsedSeason || 1;
    const isEpisodePack = episodes.length > 1;
    const isSeasonPack = episodes.length === 0;
    let streamIdSuffix;
    if (isSeasonPack) {
        streamIdSuffix = `s${season}-seasonpack`;
    } else if (isEpisodePack) {
        streamIdSuffix = `s${season}-ep${episodes[0]}-${episodes[episodes.length - 1]}`;
    } else {
        streamIdSuffix = `s${season}e${episodes[0]}`;
    }
    const streamId = `${infoHash}:${streamIdSuffix}:${resolution}`;
    const streamKey = `stream:tmdb:${tmdbId}`;
    const streamData = JSON.stringify({
        id: streamId, infoHash, season, episodes, isEpisodePack, isSeasonPack,
        title: name, resolution, languages, size
    });
    await redis.hset(streamKey, streamId, streamData);
    logger.debug({ tmdbId, streamId }, 'Added/updated stream.');
}

async function getStreamsByTmdbId(tmdbId, requestedSeason, requestedEpisode) {
    const streamData = await redis.hvals(`stream:tmdb:${tmdbId}`);
    if (!streamData.length) return [];
    
    const allStreams = streamData.map(data => JSON.parse(data));
    let filteredStreams = [];

    if (requestedSeason && requestedEpisode) {
        const exactMatches = allStreams.filter(stream => !stream.isEpisodePack && !stream.isSeasonPack && stream.season === requestedSeason && stream.episodes.includes(requestedEpisode));
        if (exactMatches.length > 0) {
            filteredStreams = exactMatches;
        } else {
            const episodePackMatches = allStreams.filter(stream => stream.isEpisodePack && stream.season === requestedSeason && requestedEpisode >= stream.episodes[0] && requestedEpisode <= stream.episodes[stream.episodes.length - 1]);
            if (episodePackMatches.length > 0) {
                filteredStreams = episodePackMatches;
            } else {
                const seasonPackMatches = allStreams.filter(stream => stream.isSeasonPack && stream.season === requestedSeason);
                if (seasonPackMatches.length > 0) filteredStreams = seasonPackMatches;
            }
        }
    } else {
        filteredStreams = allStreams;
    }

    if (filteredStreams.length === 0) return [];

    const bestTrackers = getTrackers();
    const streams = filteredStreams.map(parsed => {
        const langString = parsed.languages.join(' / ');
        const seasonNum = String(parsed.season).padStart(2, '0');
        const streamName = `[TB+] - ${parsed.resolution}`;
        let streamDescription;
        if (parsed.isSeasonPack) {
            streamDescription = `📺 Season ${seasonNum} Pack\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        } else if (parsed.isEpisodePack) {
            const startEp = String(parsed.episodes[0]).padStart(2, '0');
            const endEp = String(parsed.episodes[parsed.episodes.length - 1]).padStart(2, '0');
            streamDescription = `📺 S${seasonNum} E${startEp}-E${endEp}\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        } else {
            const episodeNum = String(parsed.episodes[0]).padStart(2, '0');
            streamDescription = `📺 S${seasonNum}E${episodeNum}\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        }
        
        let videoSizeBytes = 0;
        if (parsed.size) {
            const sizeMatch = parsed.size.match(/(\d+(\.\d+)?)\s*(GB|MB)/i);
            if (sizeMatch) {
                const sizeValue = parseFloat(sizeMatch[1]);
                const sizeUnit = sizeMatch[3].toUpperCase();
                videoSizeBytes = sizeUnit === 'GB' ? sizeValue * 1e9 : sizeValue * 1e6;
            }
        }
        
        return {
            name: streamName, 
            description: streamDescription, 
            infoHash: parsed.infoHash,
            sources: bestTrackers, 
            behaviorHints: { 
                bingeGroup: `tamilblasters-${parsed.resolution}`, 
                videoSize: videoSizeBytes > 0 ? videoSizeBytes : undefined 
            }
        };
    });

    streams.sort((a, b) => {
        const seasonA = parseInt(a.description.match(/S(\d+)|Season (\d+)/)?.[1] || 0);
        const seasonB = parseInt(b.description.match(/S(\d+)|Season (\d+)/)?.[1] || 0);
        if (seasonB !== seasonA) return seasonB - seasonA;

        const episodeA = parseInt(a.description.match(/E(\d+)/)?.[1] || 0);
        const episodeB = parseInt(b.description.match(/E(\d+)/)?.[1] || 0);
        if (episodeB !== episodeA) return episodeB - episodeA;

        const resA = parseInt(a.name.match(/\d{3,4}/)?.[0] || 0);
        const resB = parseInt(b.name.match(/\d{3,4}/)?.[0] || 0);
        return resB - resA;
    });

    return streams;
}

async function getTmdbIdByImdbId(imdbId) {
    const mappingKey = `imdb_map:${imdbId}`;
    return redis.get(mappingKey);
}

async function findCachedTmdbId(baseTitle, year) {
    let mappingKey;
    if (year) {
        mappingKey = `show_map:${baseTitle}:${year}`;
        const tmdbId = await redis.get(mappingKey);
        if (tmdbId) {
            logger.debug({ title: baseTitle, year }, 'Found cached TMDb ID with year.');
            return tmdbId;
        }
    }
    mappingKey = `show_map:${baseTitle}`;
    const tmdbId = await redis.get(mappingKey);
    if (tmdbId) {
        logger.debug({ title: baseTitle }, 'Found cached TMDb ID without year.');
    }
    return tmdbId;
}

async function updateCatalog(imdbId, name, poster, year) {
    const catalogKey = 'catalog:series';
    const score = year ? parseInt(year, 10) : 0;
    const meta = {
        id: imdbId,
        type: 'series',
        name: name,
        poster: poster,
    };
    await redis.zadd(catalogKey, score, JSON.stringify(meta));
    logger.debug({ imdbId, name }, 'Updated custom catalog.');
}

async function getCustomCatalog() {
    const catalogKey = 'catalog:series';
    const results = await redis.zrevrange(catalogKey, 0, -1);
    if (!results || results.length === 0) return [];
    return results.map(item => JSON.parse(item));
}

// --- `logUnmatchedMagnet` now accepts and stores the normalizedTitle ---
/**
 * Logs a magnet that could not be matched, storing essential diagnostic info.
 * @param {string} magnetUri - The full magnet URI.
 * @param {string} threadTitle - The original title of the forum thread.
 * @param {string} sourceUrl - The URL of the forum thread.
 * @param {string} reason - The reason for the failure.
 * @param {string} normalizedTitle - The cleaned title that was used for the API search.
 */
async function logUnmatchedMagnet(magnetUri, threadTitle, sourceUrl, reason, normalizedTitle) {
    const orphanKey = 'unmatched_magnets';
    
    const infoHashMatch = magnetUri.match(/btih:([a-fA-F0-9]{40})/i);
    const dnMatch = magnetUri.match(/dn=([^&]+)/i);

    const infoHash = infoHashMatch ? infoHashMatch[1] : 'N/A';
    const displayName = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : 'N/A';

    const data = {
        infoHash,
        displayName,
        threadTitle,
        normalizedTitle, // Add the normalized title to the log
        sourceUrl,
        reason,
        attempts: 1,
        loggedAt: new Date().toISOString()
    };
    
    await redis.lpush(orphanKey, JSON.stringify(data));
    logger.debug({ title: threadTitle, reason }, 'Logged a clean orphan magnet.');
}
// --- END OF CHANGE ---

async function updateThreadTimestamp(threadUrl) {
    const threadKey = `thread:${Buffer.from(threadUrl).toString('base64')}`;
    await redis.hset(threadKey, 'lastVisited', new Date().toISOString());
}

async function getThreadsToRevisit() {
    const keys = await redis.keys('thread:*');
    if (!keys.length) return [];

    const pipeline = redis.pipeline();
    keys.forEach(key => pipeline.hget(key, 'lastVisited'));
    const results = await pipeline.exec();
    
    const revisitThreshold = new Date();
    revisitThreshold.setHours(revisitThreshold.getHours() - config.THREAD_REVISIT_HOURS);
    
    const threadsToRevisit = [];
    results.forEach(([, lastVisited], index) => {
        if (lastVisited && new Date(lastVisited) < revisitThreshold) {
            threadsToRevisit.push(Buffer.from(keys[index].substring(7), 'base64').toString('ascii'));
        }
    });
    return threadsToRevisit;
}


// --- rescueOrphanedMagnets now uses the normalizedTitle from the orphan object ---
async function rescueOrphanedMagnets() {
    logger.info('Starting ultimate orphan rescue job...');
    const orphanKey = 'unmatched_magnets';
    const allOrphans = await redis.lrange(orphanKey, 0, -1);

    if (allOrphans.length === 0) {
        logger.info('No orphans to rescue.');
        return;
    }

    // --- START OF THE ULTIMATE FIX ---
    // 1. Get all known show mappings from the cache AND the manual hints.
    const knownTitles = new Map();
    
    // Load from manual hints first (highest priority)
    const hints = await redis.hgetall('search_hints');
    for (const title in hints) {
        knownTitles.set(title, hints[title]); // Value is "tmdb:123" or "tt123"
    }
    
    // Load from automatic cache (will not overwrite manual hints)
    const showMapKeys = await redis.keys('show_map:*');
    if (showMapKeys.length > 0) {
        const tmdbIds = await redis.mget(showMapKeys);
        showMapKeys.forEach((key, index) => {
            const title = key.split(':').slice(1, -1).join(':') || key.split(':').slice(1).join(':');
            if (title && !knownTitles.has(title)) { // Don't overwrite a manual hint
                knownTitles.set(title, `tmdb:${tmdbIds[index]}`);
            }
        });
    }
    // --- END OF THE ULTIMATE FIX ---
    
    if (knownTitles.size === 0) {
        logger.warn('Orphan rescue job: No known shows in cache or hints to match against.');
        return;
    }

    let rescuedCount = 0;
    const updatedOrphans = [];

    for (const orphanString of allOrphans) {
        let orphan = JSON.parse(orphanString);
        let rescued = false;
        
        const baseTitle = orphan.normalizedTitle; 

        if (baseTitle && knownTitles.has(baseTitle)) {
            const id = knownTitles.get(baseTitle); // This will be "tmdb:123" or "tt123"
            const [source, externalId] = id.split(':');
            
            let tmdbId = source === 'tmdb' ? externalId : await getTmdbIdByImdbId(id);

            if (tmdbId) {
                logger.info({ title: baseTitle, tmdbId }, 'Rescuing orphan! Found a match.');
                const minimalMagnet = `magnet:?xt=urn:btih:${orphan.infoHash}&dn=${encodeURIComponent(orphan.displayName)}`;
                const parsedStream = parseTitle(minimalMagnet);
                if (parsedStream) {
                    await addStream(tmdbId, parsedStream);
                    rescued = true;
                    rescuedCount++;
                }
            }
        }

        if (!rescued) {
            orphan.attempts = (orphan.attempts || 1) + 1;
            updatedOrphans.push(JSON.stringify(orphan));
        }
    }
    
    if (allOrphans.length > 0) {
        const pipeline = redis.pipeline();
        pipeline.del(orphanKey);
        if (updatedOrphans.length > 0) pipeline.rpush(orphanKey, updatedOrphans);
        await pipeline.exec();
    }
    
    logger.info({ rescued: rescuedCount, remaining: updatedOrphans.length }, 'Orphan rescue job finished.');
}



module.exports = {
    findOrCreateShow,
    addStream,
    getStreamsByTmdbId,
    getTmdbIdByImdbId,
    updateThreadTimestamp,
    getThreadsToRevisit,
    updateCatalog,
    getCustomCatalog,
    logUnmatchedMagnet,
    findCachedTmdbId,
     loadHintsIntoRedis,
    addHint,
    getHint,
    rescueOrphanedMagnets // Export the new function
};
