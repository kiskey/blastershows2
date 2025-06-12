const redis = require('./redis');
const { normalizeTitleForId } = require('../utils/fuzzy');
const config = require('../utils/config');
const logger = require('../utils/logger');

// As per requirement, all content is treated as a movie with one "season" (year)
// and multiple "episodes" (streams).

/**
 * Creates or retrieves a show. The unique ID is based on title and year.
 * @param {string} movieKey - The unique key (e.g., tbs-merc-for-none-2023)
 * @param {string} originalTitle - The human-readable title
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
         // Optionally update poster if a new one is found
         await redis.hset(showKey, 'posterUrl', posterUrl);
    }
    
    return {
        id: movieKey,
        name: `${originalTitle} (${year})`,
        poster: posterUrl,
    };
}


/**
 * Adds a parsed stream to the corresponding show.
 * @param {string} movieKey - The unique show ID
 * @param {Object} streamInfo - Parsed stream data from titleParser
 */
async function addStream(movieKey, streamInfo) {
    const { infoHash, fileIdx, name, resolution, languages, size } = streamInfo;
    const streamId = `${infoHash}:${fileIdx || 0}`;

    const streamKey = `stream:${movieKey}`;

    // Use a hash to store streams to avoid duplicates and allow easy updates
    // The field will be the unique stream ID, value is a JSON string of details
    const streamData = JSON.stringify({
        id: streamId,
        name: `[${resolution}] ${languages.join('+')}`,
        title: name,
        infoHash,
        fileIdx: fileIdx || 0,
        size
    });

    await redis.hset(streamKey, streamId, streamData);
    logger.debug({ movieKey, streamId }, 'Added/updated stream in Redis hash.');
}


async function getCatalog() {
    const keys = await redis.keys('show:*');
    if (!keys.length) return [];

    const pipeline = redis.pipeline();
    keys.forEach(key => pipeline.hgetall(key));
    const results = await pipeline.exec();

    return results.map(([, data], index) => {
        if (!data || !data.year) return null;
        return {
            id: keys[index].substring(5), // remove 'show:' prefix
            type: 'movie',
            name: `${data.originalTitle} (${data.year})`,
            poster: data.posterUrl,
        };
    }).filter(Boolean);
}

async function getMeta(movieKey) {
    const showData = await redis.hgetall(`show:${movieKey}`);
    if (!showData.originalTitle) return null;

    // Here we can build a more detailed description if needed
    const description = `Title: ${showData.originalTitle}\nYear: ${showData.year}`;

    return {
        id: movieKey,
        type: 'movie',
        name: `${showData.originalTitle} (${showData.year})`,
        poster: showData.posterUrl,
        description,
        background: showData.posterUrl // Use poster as background too
    };
}

async function getStreams(movieKey) {
    const streamData = await redis.hvals(`stream:${movieKey}`);
    if (!streamData.length) return [];

    const streams = streamData.map(data => {
        const parsed = JSON.parse(data);
        return {
            infoHash: parsed.infoHash,
            fileIdx: parsed.fileIdx,
            name: parsed.name,
            title: parsed.title,
            url: `magnet:?xt=urn:btih:${parsed.infoHash}&dn=${encodeURIComponent(parsed.title)}`
        };
    });

    // Sort by resolution (higher first)
    streams.sort((a, b) => {
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
            const encodedUrl = keys[index].substring(7); // remove 'thread:'
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
