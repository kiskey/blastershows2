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
            throw new Error('BAD_TITLE');
        }

        logger.info({ threadTitle: threadData.title, baseTitle: baseTitle, year: year }, 'Processing thread');

        let metaResult = { tmdbId: null, imdbId: null, poster: null, name: baseTitle, year: year };

        // --- NEW HINTING AND CACHING LOGIC ---
        // 1. Check for a hardcoded hint first. This is the highest priority.
        const hint = await dataManager.getHint(baseTitle);
        if (hint) {
            const [source, id] = hint.split(':');
            logger.info({ title: baseTitle, hint }, 'Found a manual hint, using it.');
            // We use the ID from the hint (which can be tmdb or imdb) to get full details
            const details = await getTvDetails(id);
            if (details) {
                // We got full details, so we can populate our metaResult
                metaResult = { ...metaResult, ...details };
                metaResult.poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
            }
        }

        // 2. If no hint was found or worked, check our automatic Redis cache.
        if (!metaResult.tmdbId) {
            const cachedTmdbId = await dataManager.findCachedTmdbId(baseTitle, year);
            if (cachedTmdbId) {
                const details = await getTvDetails(cachedTmdbId);
                if (details) {
                    metaResult = { ...metaResult, ...details };
                    metaResult.poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
                }
            }
        }
        
        // 3. If still no match, perform the full API waterfall.
        if (!metaResult.tmdbId) {
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
                    if (details && details.tmdbId) {
                        metaResult.tmdbId = details.tmdbId;
                    }
                }
            }
        }

        if (metaResult.imdbId && metaResult.tmdbId) {
            await dataManager.findOrCreateShow(metaResult.tmdbId, metaResult.imdbId, baseTitle, year);
            await dataManager.updateCatalog(metaResult.imdbId, metaResult.name, metaResult.poster, metaResult.year);
            for (const magnetUri of threadData.magnets) {
                const parsedStream = parseTitle(magnetUri);
                if (parsedStream) {
                    await dataManager.addStream(metaResult.tmdbId, parsedStream);
                } else {
                    await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl, "MAGNET_PARSE_FAILED", baseTitle);
                }
            }
        } else {
            throw new Error('METADATA_MATCH_FAILED');
        }
        
        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        const baseTitle = normalizeBaseTitle(threadData?.title || '');
        const reason = error.message.includes('timeout') ? 'API_TIMEOUT' :
                       error.message === 'METADATA_MATCH_FAILED' ? 'NO_METADATA_MATCH' :
                       error.message === 'BAD_TITLE' ? 'BAD_TITLE' :
                       'UNKNOWN_ERROR';
        
        logger.warn({ title: baseTitle, reason }, "Could not resolve show. Logging as orphan.");
        if (threadData && threadData.magnets && threadData.magnets.length > 0) {
            for (const magnetUri of threadData.magnets) {
                await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl, reason, baseTitle);
            }
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
