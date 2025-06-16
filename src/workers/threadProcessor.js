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
    let baseTitle = null;
    let threadData = { title: 'Unknown', magnets: [] };

    try {
        const html = await fetchThreadHtml(threadUrl);
        if (!html) return;

        threadData = parseThreadPage(html, threadUrl);
        if (!threadData || !threadData.title || threadData.magnets.length === 0) {
            await dataManager.updateThreadTimestamp(threadUrl);
            return;
        }

        baseTitle = normalizeBaseTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle) {
            logger.warn({ threadTitle: threadData.title }, 'Title became empty after normalization, skipping.');
            throw new Error('BAD_TITLE');
        }

        logger.info({ threadTitle: threadData.title, baseTitle: baseTitle, year: year }, 'Processing thread with normalized title');

        let metaResult = { tmdbId: null, imdbId: null };

        const cachedTmdbId = await dataManager.findCachedTmdbId(baseTitle, year);
        if (cachedTmdbId) {
            const details = await getTvDetails(cachedTmdbId);
            if (details) metaResult = details;
        } else {
            const tmdbSearch = await searchTv(baseTitle, year);
            if (tmdbSearch && tmdbSearch.id) {
                const details = await getTvDetails(tmdbSearch.id);
                if (details && details.imdbId) metaResult = { ...details };
            }
            if (!metaResult.imdbId) {
                const omdbSearch = await searchOmdb(baseTitle);
                if (omdbSearch && omdbSearch.imdbId) {
                    const details = await getTvDetails(omdbSearch.imdbId);
                    if (details && details.tmdbId) metaResult = { ...details };
                }
            }
        }

        if (metaResult.imdbId && metaResult.tmdbId) {
            await dataManager.findOrCreateShow(metaResult.tmdbId, metaResult.imdbId, baseTitle, year);
            await dataManager.updateCatalog(metaResult.imdbId, metaResult.name, metaResult.poster_path ? `https://image.tmdb.org/t/p/w500${metaResult.poster_path}` : null, metaResult.year);
            for (const magnetUri of threadData.magnets) {
                const parsedStream = parseTitle(magnetUri);
                if (parsedStream) {
                    await dataManager.addStream(metaResult.tmdbId, parsedStream);
                } else {
                    await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl, "MAGNET_PARSE_FAILED");
                }
            }
        } else {
            throw new Error('METADATA_MATCH_FAILED');
        }
        
        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        const reason = error.message.includes('timeout') ? 'API_TIMEOUT' :
                       error.message === 'METADATA_MATCH_FAILED' ? 'NO_METADATA_MATCH' :
                       error.message === 'BAD_TITLE' ? 'BAD_TITLE' :
                       'UNKNOWN_ERROR';
        
        logger.warn({ title: baseTitle || threadData?.title, reason }, "Could not resolve show. Logging magnets as orphans.");
        
        if (threadData && threadData.magnets && threadData.magnets.length > 0) {
            for (const magnetUri of threadData.magnets) {
                await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl, reason);
            }
        } else if (threadData) {
            await dataManager.logUnmatchedMagnet('N/A', threadData.title, threadUrl, reason);
        }
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
