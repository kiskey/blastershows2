// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');
const { getTrackers } = require('../utils/trackers');
const config = require('../utils/config');

async function findOrCreateShow(tmdbId, imdbId) {
    const mappingKey = `imdb_map:${imdbId}`;
    const existingTmdbId = await redis.get(mappingKey);
    if (!existingTmdbId || existingTmdbId !== tmdbId.toString()) {
        await redis.set(mappingKey, tmdbId);
        logger.info({ imdbId, tmdbId }, 'Created/refreshed IMDb to TMDb mapping.');
    }
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

async function getTmdbIdByImdbId(imdbId) {
    const mappingKey = `imdb_map:${imdbId}`;
    return redis.get(mappingKey);
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

async function getStreamsByTmdbId(tmdbId, requestedSeason, requestedEpisode) {
    const streamData = await redis.hvals(`stream:tmdb:${tmdbId}`);
    if (!streamData.length) return [];
    
    const allStreams = streamData.map(data => JSON.parse(data));

    // --- START OF NEW FILTERING LOGIC ---
    let filteredStreams = [];

    // If a specific episode is requested, filter intelligently
    if (requestedSeason && requestedEpisode) {
        // Layer 1: Find exact single episode matches
        const exactMatches = allStreams.filter(stream => 
            !stream.isEpisodePack && 
            !stream.isSeasonPack && 
            stream.season === requestedSeason &&
            stream.episodes.includes(requestedEpisode)
        );
        if (exactMatches.length > 0) {
            filteredStreams = exactMatches;
            logger.info({ tmdbId, count: exactMatches.length }, 'Found exact episode matches.');
        }

        // Layer 2: If no exact match, find episode packs that contain the episode
        if (filteredStreams.length === 0) {
            const episodePackMatches = allStreams.filter(stream => 
                stream.isEpisodePack &&
                stream.season === requestedSeason &&
                requestedEpisode >= stream.episodes[0] &&
                requestedEpisode <= stream.episodes[stream.episodes.length - 1]
            );
            if (episodePackMatches.length > 0) {
                filteredStreams = episodePackMatches;
                logger.info({ tmdbId, count: episodePackMatches.length }, 'Found matching episode packs.');
            }
        }

        // Layer 3: If still no match, find a full season pack for that season
        if (filteredStreams.length === 0) {
            const seasonPackMatches = allStreams.filter(stream => 
                stream.isSeasonPack &&
                stream.season === requestedSeason
            );
            if (seasonPackMatches.length > 0) {
                filteredStreams = seasonPackMatches;
                logger.info({ tmdbId, count: seasonPackMatches.length }, 'Found matching season packs.');
            }
        }
    } else {
        // If no specific episode is requested (e.g., from the series detail page root), return all streams.
        filteredStreams = allStreams;
        logger.info({ tmdbId, count: filteredStreams.length }, 'No specific episode requested, returning all streams for series.');
    }

    if (filteredStreams.length === 0) {
        return []; // Return early if no streams match the filter
    }
    // --- END OF NEW FILTERING LOGIC ---

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
                videoSize: videoSizeBytes > 0 ? videoSizeBytes : undefined,
            }
        };
    });

    // Sort the final, filtered list by episode and then resolution
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
            const encodedUrl = keys[index].substring(7);
            threadsToRevisit.push(Buffer.from(encodedUrl, 'base64').toString('ascii'));
        }
    });

    return threadsToRevisit;
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
};
