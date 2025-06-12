// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');

/**
 * Creates or retrieves a show. The unique ID is based on title and year.
 * @param {string} movieKey - The unique key (e.g., tbs-mercy-for-none-2023)
 * @param {string} originalTitle - The human-readable title from the thread
 * @param {string} posterUrl - The poster URL
 * @param {string} year - The release year
 * @returns {Promise<{id: string, name: string, poster: string}>}
 */
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
 * Adds a parsed stream to the corresponding show. Handles multi-episode torrents.
 * @param {string} movieKey - The unique show ID
 * @param {Object} streamInfo - Parsed stream data from titleParser
 */
async function addStream(movieKey, streamInfo) {
    const { infoHash, name, resolution, languages, size, season, episodes } = streamInfo;

    // If the torrent is for a pack but no specific episodes were parsed, treat it as one stream for the season.
    if (episodes.length === 0 && season) {
        const streamId = `${infoHash}:s${season}`; // Unique ID for a season pack
        const streamKey = `stream:${movieKey}`;
        const streamData = JSON.stringify({
            id: streamId,
            name: `[${resolution}] Season ${season} Pack`, // User-facing name
            title: name,
            infoHash,
            season,
            episode: null, // Indicates it's a pack, not a single episode
            languages,
            size
        });
        await redis.hset(streamKey, streamId, streamData);
        logger.debug({ movieKey, streamId }, 'Added/updated season pack stream.');
        return;
    }

    // If we have specific episode numbers, create a stream for each one.
    for (const episode of episodes) {
        // Create a unique ID for this specific episode and quality
        const streamId = `${infoHash}:s${season}e${episode}:${resolution}`;
        const streamKey = `stream:${movieKey}`;

        // ---- CHANGE: Store season and episode in the stream data ----
        const streamData = JSON.stringify({
            id: streamId,
            infoHash,
            season,
            episode, // Store the specific episode number
            title: name, // The full original name of the torrent
            resolution,
            languages,
            size
        });

        await redis.hset(streamKey, streamId, streamData);
        logger.debug({ movieKey, streamId }, 'Added/updated episode stream.');
    }
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
            id: keys[index].substring(5), // remove 'show:' prefix
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

        // ---- START OF CHANGES ----

        // Construct the new user-facing name and title
        let streamName, streamTitle;
        const langString = parsed.languages.join('+');

        if (parsed.episode) {
            // It's a single episode
            const seasonNum = String(parsed.season).padStart(2, '0');
            const episodeNum = String(parsed.episode).padStart(2, '0');
            streamName = `${parsed.resolution} - S${seasonNum}E${episodeNum}`;
            streamTitle = `S${seasonNum}E${episodeNum} - ${langString}\n${parsed.size || ''}`;
        } else {
            // It's a season pack
            const seasonNum = String(parsed.season).padStart(2, '0');
            streamName = `${parsed.resolution} - Season ${seasonNum} Pack`;
            streamTitle = `Season ${seasonNum} - ${langString}\n${parsed.size || ''}`;
        }

        return {
            name: streamName,
            title: streamTitle,
            infoHash: parsed.infoHash,
            url: `magnet:?xt=urn:btih:${parsed.infoHash}&dn=${encodeURIComponent(parsed.title)}`
        };

        // ---- END OF CHANGES ----
    });

    // Sort streams: Higher resolution first, then by season, then by episode
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
