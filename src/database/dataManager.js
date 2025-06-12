// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');
const { getTrackers } = require('../utils/trackers'); // Import the tracker utility

// ... findOrCreateShow, addStream, getCatalog, getMeta functions remain the same ...
async function findOrCreateShow(movieKey, originalTitle, posterUrl, year) {
    const showKey = `show:${movieKey}`;
    const exists = await redis.exists(showKey);
    
    if (!exists) {
        await redis.hset(showKey, {
            originalTitle,
            posterUrl,
            year,
            createdAt: new Date().toISOString()
        });
        logger.info({ movieKey, title: originalTitle }, 'Created new show entry in Redis.');
    } else {
         await redis.hset(showKey, 'posterUrl', posterUrl);
    }
    
    const pttTitleMatch = originalTitle.match(/^([^[(]+)/);
    const cleanName = pttTitleMatch ? pttTitleMatch[1].trim() : originalTitle;

    return {
        id: movieKey,
        name: `${cleanName} (${year})`,
        poster: posterUrl,
    };
}

async function addStream(movieKey, streamInfo) {
    const { infoHash, name, resolution, languages, size, episodes } = streamInfo;
    const season = streamInfo.season || 1; 

    const isPack = episodes.length > 1;
    const singleEpisode = episodes.length === 1 ? episodes[0] : null;

    if (episodes.length === 0) {
        logger.warn({ movieKey, name }, "Could not add stream: No episode information found in torrent title.");
        return;
    }

    const streamIdSuffix = isPack ? `s${season}-pack` : `s${season}e${singleEpisode}`;
    const streamId = `${infoHash}:${streamIdSuffix}:${resolution}`;
    const streamKey = `stream:${movieKey}`;

    const streamData = JSON.stringify({
        id: streamId,
        infoHash,
        season,
        episodes,
        isPack,
        title: name,
        resolution,
        languages,
        size
    });

    await redis.hset(streamKey, streamId, streamData);
    logger.debug({ movieKey, streamId, isPack }, 'Added/updated stream.');
}

async function getCatalog() {
    const keys = await redis.keys('show:*');
    if (!keys.length) return [];

    const pipeline = redis.pipeline();
    keys.forEach(key => pipeline.hgetall(key));
    const results = await pipeline.exec();

    return results.map(([, data], index) => {
        if (!data || !data.year) return null;
        
        const pttTitleMatch = data.originalTitle.match(/^([^[(]+)/);
        const cleanName = pttTitleMatch ? pttTitleMatch[1].trim() : data.originalTitle;

        return {
            id: keys[index].substring(5),
            type: 'movie',
            name: `${cleanName} (${data.year})`,
            poster: data.posterUrl,
        };
    }).filter(Boolean);
}

async function getMeta(movieKey) {
    const showData = await redis.hgetall(`show:${movieKey}`);
    if (!showData.originalTitle) return null;

    const pttTitleMatch = showData.originalTitle.match(/^([^[(]+)/);
    const cleanName = pttTitleMatch ? pttTitleMatch[1].trim() : showData.originalTitle;
    const description = `Title: ${cleanName}\nYear: ${showData.year}`;

    return {
        id: movieKey,
        type: 'movie',
        name: `${cleanName} (${showData.year})`,
        poster: showData.posterUrl,
        description,
        background: showData.posterUrl
    };
}


async function getStreams(movieKey) {
    const streamData = await redis.hvals(`stream:${movieKey}`);
    if (!streamData.length) return [];
    
    // ---- START OF ENHANCEMENTS ----
    const bestTrackers = getTrackers();
    const trackerString = bestTrackers.map(t => `tr=${encodeURIComponent(t)}`).join('&');
    // ---- END OF ENHANCEMENTS ----

    const streams = streamData.map(data => {
        const parsed = JSON.parse(data);
        const langString = parsed.languages.join(' / ');
        const seasonNum = String(parsed.season).padStart(2, '0');

        let streamName, streamDescription;

        if (parsed.isPack) {
            const startEp = String(parsed.episodes[0]).padStart(2, '0');
            const endEp = String(parsed.episodes[parsed.episodes.length - 1]).padStart(2, '0');
            streamName = `[${parsed.resolution}] S${seasonNum} E${startEp}-E${endEp} Pack`;
            streamDescription = `📺 Season ${seasonNum} Pack\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        } else {
            const episodeNum = String(parsed.episodes[0]).padStart(2, '0');
            streamName = `[${parsed.resolution}] S${seasonNum}E${episodeNum}`;
            streamDescription = `📺 S${seasonNum}E${episodeNum}\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        }
        
        // ---- START OF ENHANCEMENTS ----
        // Convert size string (e.g., "3.3GB") to bytes for videoSize hint
        let videoSizeBytes = 0;
        if (parsed.size) {
            const sizeMatch = parsed.size.match(/(\d+(\.\d+)?)\s*(GB|MB)/i);
            if (sizeMatch) {
                const sizeValue = parseFloat(sizeMatch[1]);
                const sizeUnit = sizeMatch[3].toUpperCase();
                if (sizeUnit === 'GB') {
                    videoSizeBytes = sizeValue * 1024 * 1024 * 1024;
                } else if (sizeUnit === 'MB') {
                    videoSizeBytes = sizeValue * 1024 * 1024;
                }
            }
        }
        
        return {
            name: streamName,
            description: streamDescription, // Use 'description' instead of 'title'
            infoHash: parsed.infoHash,
            sources: bestTrackers, // Add the list of trackers
            // The 'url' property is not needed when infoHash is present, but sources can be added.
            // Stremio will construct the magnet link.

            behaviorHints: {
                // This helps Stremio auto-select the next episode from the same addon/quality
                bingeGroup: `tamilblasters-${parsed.resolution}`,
                // Provide videoSize if available to help subtitle addons
                videoSize: videoSizeBytes > 0 ? videoSizeBytes : undefined, 
            }
        };
        // ---- END OF ENHANCEMENTS ----
    });

    // Sort streams: Higher resolution first, then by season, then by episode number
    streams.sort((a, b) => {
        const resA = parseInt(a.name.match(/\d{3,4}/)?.[0] || 0);
        const resB = parseInt(b.name.match(/\d{3,4}/)?.[0] || 0);
        if (resB !== resA) return resB - resA;

        // The description field now holds the S/E info reliably
        const seasonA = parseInt(a.description.match(/S(\d+)/)?.[1] || a.description.match(/Season (\d+)/)?.[1] || 0);
        const seasonB = parseInt(b.description.match(/S(\d+)/)?.[1] || b.description.match(/Season (\d+)/)?.[1] || 0);
        if (seasonA !== seasonB) return seasonA - seasonB;
        
        const episodeA = parseInt(a.description.match(/E(\d+)/)?.[1] || 0);
        const episodeB = parseInt(b.description.match(/E(\d+)/)?.[1] || 0);
        return episodeA - episodeB;
    });

    return streams;
}

// ... updateThreadTimestamp and getThreadsToRevisit functions remain the same ...
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
    getCatalog,
    getMeta,
    getStreams,
    updateThreadTimestamp,
    getThreadsToRevisit
};
