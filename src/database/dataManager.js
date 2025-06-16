// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');
const { getTrackers } = require('../utils/trackers');
const config = require('../utils/config');
const { parseTitle, normalizeBaseTitle } = require('../parser/titleParser'); // We need this for the rescue op

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

async function logUnmatchedMagnet(magnetUri, originalTitle, sourceUrl, reason) {
    const orphanKey = 'unmatched_magnets';
    const data = {
        magnet: magnetUri,
        title: originalTitle,
        source: sourceUrl,
        reason: reason,
        attempts: 1, // First time it's logged, attempts is 1
        loggedAt: new Date().toISOString()
    };
    await redis.lpush(orphanKey, JSON.stringify(data));
    logger.debug({ title: originalTitle, reason }, 'Logged an orphan magnet.');
}

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


// --- `rescueOrphanedMagnets` is now much smarter ---
async function rescueOrphanedMagnets() {
    logger.info('Starting advanced orphan rescue job...');
    const orphanKey = 'unmatched_magnets';
    const allOrphans = await redis.lrange(orphanKey, 0, -1);

    if (allOrphans.length === 0) {
        logger.info('No orphans to rescue.');
        return;
    }

    const showMapKeys = await redis.keys('show_map:*');
    const knownTitles = new Map();
    if (showMapKeys.length > 0) {
        const tmdbIds = await redis.mget(showMapKeys);
        showMapKeys.forEach((key, index) => {
            const title = key.split(':').slice(1, -1).join(':') || key.split(':').slice(1).join(':');
            const tmdbId = tmdbIds[index];
            if (title && tmdbId) {
                knownTitles.set(title, tmdbId);
            }
        });
    }
    
    if (knownTitles.size === 0) {
        logger.warn('Orphan rescue job: No known shows in cache to match against.');
        return;
    }

    let rescuedCount = 0;
    const updatedOrphans = [];

    for (const orphanString of allOrphans) {
        let orphan = JSON.parse(orphanString);
        let rescued = false;

        const baseTitle = normalizeBaseTitle(orphan.title);

        if (knownTitles.has(baseTitle)) {
            const tmdbId = knownTitles.get(baseTitle);
            const imdbId = await redis.get(`tmdb_map:${tmdbId}`); // Assuming we store a reverse map

            if (tmdbId) {
                logger.info({ title: baseTitle, tmdbId }, 'Rescuing orphan! Found a match in cache.');
                const parsedStream = parseTitle(orphan.magnet);
                if (parsedStream) {
                    await addStream(tmdbId, parsedStream);
                    rescuedCount++;
                    rescued = true;
                }
            }
        }

        if (!rescued) {
            // If not rescued, increment the attempt counter and keep it in the list
            orphan.attempts = (orphan.attempts || 1) + 1;
            updatedOrphans.push(JSON.stringify(orphan));
        }
    }
    
    // Atomically replace the old orphan list with the new one (containing only un-rescued items)
    if (allOrphans.length > 0) {
        const pipeline = redis.pipeline();
        pipeline.del(orphanKey);
        if (updatedOrphans.length > 0) {
            pipeline.rpush(orphanKey, updatedOrphans);
        }
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
    rescueOrphanedMagnets // Export the new function
};
