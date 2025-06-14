// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');
const { getTrackers } = require('../utils/trackers');
const config = require('../utils/config');

// NEW SCHEMA:
// show_map:{baseTitle}:{year} -> tmdbId (e.g., show_map:la-brea:2022 -> 126154)
// show_map:{baseTitle} -> tmdbId (e.g., show_map:and-just-like-that -> 117621)
// stream:tmdb:{tmdbId} -> HASH of all streams for that show

async function findOrCreateShow(baseTitle, year, tmdbId) {
    // We create mappings from our title/year to the official TMDb ID.
    // This allows us to find the TMDb ID again in the future if we only have the title.
    const mappingKeyWithYear = `show_map:${baseTitle}:${year}`;
    const mappingKeyWithoutYear = `show_map:${baseTitle}`;
    
    const pipeline = redis.pipeline();
    pipeline.set(mappingKeyWithYear, tmdbId, 'EX', 60 * 60 * 24 * 30); // Expire in 30 days
    pipeline.set(mappingKeyWithoutYear, tmdbId, 'EX', 60 * 60 * 24 * 30);
    await pipeline.exec();
    
    logger.info({ title: baseTitle, year, tmdbId }, 'Created/refreshed mapping to TMDb ID.');
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
    // The stream key is now based on the TMDb ID
    const streamKey = `stream:tmdb:${tmdbId}`;

    const streamData = JSON.stringify({
        id: streamId, infoHash, season, episodes, isEpisodePack, isSeasonPack,
        title: name, resolution, languages, size
    });

    await redis.hset(streamKey, streamId, streamData);
    logger.debug({ tmdbId, streamId }, 'Added/updated stream.');
}

async function getStreamsByTmdbId(tmdbId) {
    const streamKey = `stream:tmdb:${tmdbId}`;
    const streamData = await redis.hvals(streamKey);
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

    // Sort by season, then episode, then resolution
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
    updateThreadTimestamp,
    getThreadsToRevisit
};
