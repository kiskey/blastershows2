// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');

// ... findOrCreateShow, getCatalog, getMeta functions remain the same ...
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


/**
 * Adds a parsed stream to the corresponding show. Handles multi-episode torrents correctly.
 * @param {string} movieKey - The unique show ID
 * @param {Object} streamInfo - Parsed stream data from titleParser
 */
async function addStream(movieKey, streamInfo) {
    // ---- START OF NEW LOGIC ----
    const { infoHash, name, resolution, languages, size, episodes } = streamInfo;
    const season = streamInfo.season || 1;

    // Determine if this is a single episode or a pack
    const isPack = episodes.length > 1;
    const singleEpisode = episodes.length === 1 ? episodes[0] : null;

    if (episodes.length === 0) {
        logger.warn({ movieKey, name }, "Could not add stream: No episode information found.");
        return; // Do not add a stream if no episodes could be parsed.
    }

    // Create a unique ID. For packs, just use the season. For single eps, use the episode number.
    const streamIdSuffix = isPack ? `s${season}-pack` : `s${season}e${singleEpisode}`;
    const streamId = `${infoHash}:${streamIdSuffix}:${resolution}`;

    const streamKey = `stream:${movieKey}`;

    // Store all relevant info, including the episode array for packs.
    const streamData = JSON.stringify({
        id: streamId,
        infoHash,
        season,
        episodes, // Store the full array [1, 2, 3...] or [7]
        isPack,
        title: name,
        resolution,
        languages,
        size
    });

    await redis.hset(streamKey, streamId, streamData);
    logger.debug({ movieKey, streamId, isPack }, 'Added/updated stream.');
    // ---- END OF NEW LOGIC ----
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

    const streams = streamData.map(data => {
        const parsed = JSON.parse(data);
        const langString = parsed.languages.join('+');
        const seasonNum = String(parsed.season).padStart(2, '0');

        let streamName, streamTitle;

        // ---- START OF NEW LOGIC ----
        if (parsed.isPack) {
            // It's a pack of multiple episodes
            const startEp = String(parsed.episodes[0]).padStart(2, '0');
            const endEp = String(parsed.episodes[parsed.episodes.length - 1]).padStart(2, '0');
            streamName = `${parsed.resolution} - S${seasonNum} E${startEp}-E${endEp} Pack`;
            streamTitle = `Season ${seasonNum} Pack - ${langString}\n${parsed.size || ''}`;
        } else {
            // It's a single episode
            const episodeNum = String(parsed.episodes[0]).padStart(2, '0');
            streamName = `${parsed.resolution} - S${seasonNum}E${episodeNum}`;
            streamTitle = `S${seasonNum}E${episodeNum} - ${langString}\n${parsed.size || ''}`;
        }
        // ---- END OF NEW LOGIC ----

        return {
            name: streamName,
            title: streamTitle,
            infoHash: parsed.infoHash,
            url: `magnet:?xt=urn:btih:${parsed.infoHash}&dn=${encodeURIComponent(parsed.title)}`
        };
    });

    // Sorting logic remains the same and will handle packs correctly
    streams.sort((a, b) => {
        const resA = parseInt(a.name.match(/\d{3,4}/)?.[0] || 0);
        const resB = parseInt(b.name.match(/\d{3,4}/)?.[0] || 0);
        if (resB !== resA) return resB - resA;

        const seasonA = parseInt(a.title.match(/S(\d+)/)?.[1] || 0);
        const seasonB = parseInt(b.title.match(/S(\d+)/)?.[1] || 0);
        if (seasonA !== seasonB) return seasonA - seasonB;
        
        const episodeA = parseInt(a.title.match(/E(\d+)/)?.[1] || 0);
        const episodeB = parseInt(b.title.match(/E(\d+)/)?.[1] || 0);
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
