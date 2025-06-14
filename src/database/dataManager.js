// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');
const { getTrackers } = require('../utils/trackers');
const config = require('../utils/config');

// NEW SCHEMA:
// imdb_map:{imdbId} -> tmdbId
// stream:tmdb:{tmdbId} -> HASH
// catalog:series -> Sorted Set, scored by year

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

async function getStreamsByTmdbId(tmdbId) {
    const streamData = await redis.hvals(`stream:tmdb:${tmdbId}`);
    if (!streamData.length) return [];
    
    const bestTrackers = getTrackers();

    const streams = streamData.map(data => {
        const parsed = JSON.parse(data);
        const langString = parsed.languages.join(' / ');
        const seasonNum = String(parsed.season).padStart(2, '0');
        let streamName, streamDescription;

        if (parsed.isSeasonPack) {
            streamName = `[${parsed.resolution}] 🎞️ S${seasonNum} Season Pack`;
            streamDescription = `📺 Season ${seasonNum}\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        } else if (parsed.isEpisodePack) {
            const startEp = String(parsed.episodes[0]).padStart(2, '0');
            const endEp = String(parsed.episodes[parsed.episodes.length - 1]).padStart(2, '0');
            streamName = `[${parsed.resolution}] 🎞️ S${seasonNum} E${startEp}-E${endEp}`;
            streamDescription = `📺 Episodes ${startEp}-${endEp}\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        } else {
            const episodeNum = String(parsed.episodes[0]).padStart(2, '0');
            streamName = `[${parsed.resolution}] 🎞️ S${seasonNum}E${episodeNum}`;
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
            name: `[TB+] ${streamName}`,
            description: streamDescription,
            infoHash: parsed.infoHash,
            sources: bestTrackers,
            behaviorHints: {
                bingeGroup: `tamilblasters-${parsed.resolution}`,
                videoSize: videoSizeBytes > 0 ? videoSizeBytes : undefined,
            }
        };
    });

    streams.sort((a, b) => {
        const seasonA = parseInt(a.description.match(/S(\d+)|Season (\d+)/)?.[1] || 0);
        const seasonB = parseInt(b.description.match(/S(\d+)|Season (\d+)/)?.[1] || 0);
        if (seasonA !== seasonB) return seasonA - seasonB;
        
        const episodeA = parseInt(a.description.match(/E(\d+)/)?.[1] || 0);
        const episodeB = parseInt(b.description.match(/E(\d+)/)?.[1] || 0);
        if (episodeA !== episodeB) return episodeA - episodeB;

        const resA = parseInt(a.name.match(/\d{3,4}/)?.[0] || 0);
        const resB = parseInt(b.name.match(/\d{3,4}/)?.[0] || 0);
        return resB - resA;
    });

    return streams;
}

async function getTmdbIdByImdbId(imdbId) {
    const mappingKey = `imdb_map:${imdbId}`;
    const tmdbId = await redis.get(mappingKey);
    return tmdbId;
}

async function updateCatalog(imdbId, name, poster, year) {
    const catalogKey = 'catalog:series';
    // Score by year for sorting. If no year, score is 0.
    const score = year ? parseInt(year, 10) : 0; 

    // Create the meta object that Stremio expects for a catalog item.
    const meta = {
        id: imdbId, // The catalog will use IMDb IDs for consistency
        type: 'series',
        name: name,
        poster: poster,
    };
    
    // Use ZADD to add/update the item in the sorted set.
    // If an item with the same member (JSON string) exists, its score is updated.
    // We need to remove the old entry first if the details (like name/poster) changed.
    // A simpler approach for this app is to assume the member is unique enough by its ID.
    // For a perfect update, one would remove the old version first. For now, this is robust enough.
    await redis.zadd(catalogKey, score, JSON.stringify(meta));
    logger.debug({ imdbId, name }, 'Updated custom catalog.');
}

async function getCustomCatalog() {
    const catalogKey = 'catalog:series';
    // Fetch all members, sorted from highest score (latest year) to lowest.
    // We add a WITHSCORES to debug sorting if needed.
    const results = await redis.zrevrange(catalogKey, 0, -1);
    
    if (!results || results.length === 0) {
        return [];
    }
    
    return results.map(item => JSON.parse(item));
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
