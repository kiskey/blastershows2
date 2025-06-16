// src/workers/threadProcessor.js

const { parentPort } = require('worker_threads');
const axios = require('axios');
const { parseThreadPage } = require('../parser/htmlParser');
const { parseTitle, normalizeBaseTitle } = require('../parser/titleParser');
const dataManager = require('../database/dataManager');
const { searchTv, getTvDetails } = require('../utils/tmdb');
const { searchOmdb } = require('../utils/omdb');
const config = require('../utils/config');
const logger = require('../utils/logger');

async function fetchThreadHtml(url) {
    try {
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': config.USER_AGENT },
            timeout: 15000
        });
        return data;
    } catch (error) {
        if (error.code !== 'ECONNABORTED' && (!error.response || error.response.status !== 404)) {
            logger.warn({ url, err: error.message }, 'Failed to fetch thread HTML.');
        }
        return null;
    }
}

async function processThread(threadUrl) {
    let metaResult = null;
    let baseTitle = null;
    let threadData = null;

    try {
        const html = await fetchThreadHtml(threadUrl);
        if (!html) return;

        threadData = parseThreadPage(html, threadUrl);
        if (!threadData || threadData.magnets.length === 0) {
            await dataManager.updateThreadTimestamp(threadUrl);
            return;
        }

        baseTitle = normalizeBaseTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle) {
            logger.warn({ threadTitle: threadData.title }, 'Could not normalize a base title from thread.');
            throw new Error('Title normalization failed');
        }

        metaResult = { tmdbId: null, imdbId: null, poster: null, name: baseTitle, year: year };

        const cachedTmdbId = await dataManager.findCachedTmdbId(baseTitle, year);
        if (cachedTmdbId) {
            metaResult.tmdbId = cachedTmdbId;
            const details = await getTvDetails(cachedTmdbId);
            if (details) {
                metaResult.imdbId = details.imdbId;
                metaResult.poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
                metaResult.name = details.name;
                metaResult.year = details.first_air_date ? details.first_air_date.substring(0, 4) : year;
            }
        } else {
            const tmdbSearch = await searchTv(baseTitle, year);
            if (tmdbSearch && tmdbSearch.id) {
                const details = await getTvDetails(tmdbSearch.id);
                if (details && details.imdbId) {
                    metaResult = { ...metaResult, ...details };
                    metaResult.poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
                }
            }
            if (!metaResult.imdbId) {
                const omdbSearch = await searchOmdb(baseTitle);
                if (omdbSearch && omdbSearch.imdbId) {
                    metaResult.imdbId = omdbSearch.imdbId;
                    metaResult.poster = metaResult.poster || omdbSearch.poster;
                    metaResult.name = omdbSearch.title;
                    metaResult.year = omdbSearch.year;
                    const details = await getTvDetails(metaResult.imdbId);
                    if(details && details.tmdbId) metaResult.tmdbId = details.tmdbId;
                }
            }
        }
        
        if (!metaResult.imdbId || !metaResult.tmdbId) {
            // This will be caught by the catch block below
            throw new Error('METADATA_LOOKUP_FAILED');
        }

        // --- Success Path ---
        await dataManager.findOrCreateShow(metaResult.tmdbId, metaResult.imdbId, baseTitle, year);
        await dataManager.updateCatalog(metaResult.imdbId, metaResult.name, metaResult.poster, metaResult.year);
        for (const magnetUri of threadData.magnets) {
            const parsedStream = parseTitle(magnetUri);
            if (parsedStream) {
                await dataManager.addStream(metaResult.tmdbId, parsedStream);
            }
        }
        
        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        // --- START OF NEW ERROR HANDLING & ORPHAN LOGGING ---
        const reason = error.message.includes('timeout') ? 'API_TIMEOUT' :
                       error.message.includes('METADATA_LOOKUP_FAILED') ? 'NO_METADATA_MATCH' :
                       'UNKNOWN_ERROR';
        
        logger.warn({ title: baseTitle || threadData?.title, reason }, "Could not resolve show. Logging magnets as orphans.");
        
        if (threadData && threadData.magnets) {
            for (const magnetUri of threadData.magnets) {
                await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl, reason);
            }
        }
        // --- END OF NEW ERROR HANDLING & ORPHAN LOGGING ---
    }
}

if (!parentPort) {
    process.exit();
}

parentPort.on('message', async (task) => {
    if (task && task.url) {
        await processThread(task.url);
        if (global.gc) {
            global.gc();
        }
        parentPort.postMessage('done');
    }
});

parentPort.postMessage('ready');
