// src/database/dataManager.js

const redis = require('./redis');
const logger = require('../utils/logger');
const { getTrackers } = require('../utils/trackers');
const config = require('../utils/config'); 

async function findOrCreateShow(movieKey, originalTitle, posterUrl, year) {
    const showKey = `show:${movieKey}`;
    const exists = await redis.exists(showKey);
    
    if (!exists) {
        await redis.hset(showKey, {
            originalTitle,
            posterUrl,
            year: year || '', 
            createdAt: new Date().toISOString()
        });
        logger.info({ movieKey, title: originalTitle }, 'Created new show entry in Redis.');
    } else {
         await redis.hset(showKey, 'posterUrl', posterUrl);
    }
}

async function addStream(movieKey, streamInfo) {
    const { infoHash, name, resolution, languages, size, episodes, season: parsedSeason } = streamInfo;

    if (!parsedSeason && episodes.length === 0) {
        logger.warn({ movieKey, name }, "Could not add stream: No season or episode info could be parsed.");
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
    const streamKey = `stream:${movieKey}`;

    const streamData = JSON.stringify({
        id: streamId,
        infoHash, season, episodes, isEpisodePack, isSeasonPack,
        title: name, resolution, languages, size
    });

    await redis.hset(streamKey, streamId, streamData);
    logger.debug({ movieKey, streamId }, 'Added/updated stream.');
}

async function getCatalog() {
    const keys = await redis.keys('show:*');
    if (!keys.length) return [];

    const pipeline = redis.pipeline();
    keys.forEach(key => pipeline.hgetall(key));
    const results = await pipeline.exec();

    let metas = results.map(([, data], index) => {
        if (!data || !data.originalTitle) return null;
        
        const pttTitleMatch = data.originalTitle.match(/^([^[(]+)/);
        const cleanName = pttTitleMatch ? pttTitleMatch[1].trim() : data.originalTitle;
        const nameWithYear = data.year ? `${cleanName} (${data.year})` : cleanName;

        return {
            id: keys[index].substring(5),
            type: 'movie',
            name: nameWithYear,
            poster: data.posterUrl,
            year: data.year ? parseInt(data.year, 10) : null 
        };
    }).filter(Boolean);

    metas.sort((a, b) => {
        const yearA = a.year;
        const yearB = b.year;
        const nameA = a.name.toLowerCase();
        const nameB = b.name.toLowerCase();

        if (yearA && !yearB) return 1;
        if (!yearA && yearB) return -1;
        if (!yearA && !yearB) {
            if (nameA < nameB) return -1;
            if (nameA > nameB) return 1;
            return 0;
        }
        if (yearA !== yearB) return yearB - yearA;
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return 0;
    });

    return metas;
}

async function getMeta(movieKey) {
    const showData = await redis.hgetall(`show:${movieKey}`);
    if (!showData.originalTitle) return null;

    const pttTitleMatch = showData.originalTitle.match(/^([^[(]+)/);
    const cleanName = pttTitleMatch ? pttTitleMatch[1].trim() : showData.originalTitle;
    const description = showData.year ? `Title: ${cleanName}\nYear: ${showData.year}` : `Title: ${cleanName}`;
    const nameWithYear = showData.year ? `${cleanName} (${showData.year})` : cleanName;

    return {
        id: movieKey,
        type: 'movie',
        name: nameWithYear,
        poster: showData.posterUrl,
        description,
        background: showData.posterUrl
    };
}

async function getStreams(movieKey) {
    const streamData = await redis.hvals(`stream:${movieKey}`);
    if (!streamData.length) return [];
    
    const bestTrackers = getTrackers();

    const streams = streamData.map(data => {
        const parsed = JSON.parse(data);
        const langString = parsed.languages.join(' / ');
        const seasonNum = String(parsed.season).padStart(2, '0');

        let streamName, streamDescription;

        if (parsed.isSeasonPack) {
            streamName = `[${parsed.resolution}] S${seasonNum} Season Pack`;
            streamDescription = `📺 Season ${seasonNum}\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        } else if (parsed.isEpisodePack) {
            const startEp = String(parsed.episodes[0]).padStart(2, '0');
            const endEp = String(parsed.episodes[parsed.episodes.length - 1]).padStart(2, '0');
            streamName = `[${parsed.resolution}] S${seasonNum} E${startEp}-E${endEp} Pack`;
            streamDescription = `📺 Episodes ${startEp}-${endEp}\n💾 ${parsed.size || 'N/A'}\n🗣️ ${langString}`;
        } else {
            const episodeNum = String(parsed.episodes[0]).padStart(2, '0');
            streamName = `[${parsed.resolution}] S${seasonNum}E${episodeNum}`;
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

    streams.sort((a, b) => {
        const resA = parseInt(a.name.match(/\d{3,4}/)?.[0] || 0);
        const resB = parseInt(b.name.match(/\d{3,4}/)?.[0] || 0);
        if (resB !== resA) return resB - resA;

        const seasonA = parseInt(a.description.match(/S(\d+)|Season (\d+)/)?.[1] || 0);
        const seasonB = parseInt(b.description.match(/S(\d+)|Season (\d+)/)?.[1] || 0);
        if (seasonA !== seasonB) return seasonA - seasonB;
        
        const episodeA = parseInt(a.description.match(/E(\d+)/)?.[1] || 0);
        const episodeB = parseInt(b.description.match(/E(\d+)/)?.[1] || 0);
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
    // This line requires the 'config' object
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
