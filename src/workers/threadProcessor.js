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
        if (!threadData || threadData.magnets.length === 0) {
            await dataManager.updateThreadTimestamp(threadUrl);
            return;
        }

        // 1. Get the base title and year ONCE from the clean THREAD TITLE.
        baseTitle = normalizeBaseTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle) {
            logger.warn({ threadTitle: threadData.title }, 'Could not normalize a base title from thread.');
            throw new Error('TITLE_NORMALIZATION_FAILED');
        }

        let metaResult = { tmdbId: null, imdbId: null, poster: null, name: baseTitle, year: year };

        // 2. Check our cache first to avoid redundant API calls
        const cachedTmdbId = await dataManager.findCachedTmdbId(baseTitle, year);
        if (cachedTmdbId) {
            const details = await getTvDetails(cachedTmdbId);
            if (details) {
                metaResult.tmdbId = details.tmdbId;
                metaResult.imdbId = details.imdbId;
                metaResult.poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
                metaResult.name = details.name;
                metaResult.year = details.first_air_date ? details.first_air_date.substring(0, 4) : year;
            }
        } else {
            // 3. If not cached, perform the full API waterfall to find metadata
            const tmdbSearch = await searchTv(baseTitle, year);
            if (tmdbSearch && tmdbSearch.id) {
                const details = await getTvDetails(tmdbSearch.id);
                if (details && details.imdbId) {
                    metaResult = { ...metaResult, ...details }; // Spread details to get tmdbId and imdbId
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

        // 4. Final check: If we have IDs, process. Otherwise, throw to the catch block.
        if (!metaResult.imdbId || !metaResult.tmdbId) {
            throw new Error('METADATA_MATCH_FAILED');
        }

        // --- Success Path ---
        await dataManager.findOrCreateShow(metaResult.tmdbId, metaResult.imdbId, baseTitle, year);
        await dataManager.updateCatalog(metaResult.imdbId, metaResult.name, metaResult.poster, metaResult.year);
        
        for (const magnetUri of threadData.magnets) {
            const parsedStream = parseTitle(magnetUri);
            if (parsedStream) {
                await dataManager.addStream(metaResult.tmdbId, parsedStream);
            } else {
                await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl, "MAGNET_PARSE_FAILED");
            }
        }
        
        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        // Centralized error handling for logging orphans
        const reason = error.message.includes('timeout') ? 'API_TIMEOUT' :
                       error.message.includes('METADATA_MATCH_FAILED') ? 'NO_METADATA_MATCH' :
                       error.message.includes('TITLE_NORMALIZATION_FAILED') ? 'BAD_TITLE' :
                       'UNKNOWN_ERROR';
        
        logger.warn({ title: baseTitle || threadData?.title, reason }, "Could not resolve show. Logging magnets as orphans.");
        
        if (threadData && threadData.magnets && threadData.magnets.length > 0) {
            for (const magnetUri of threadData.magnets) {
                await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl, reason);
            }
        } else if (threadData) {
            // Log even if no magnets were found, if title normalization failed early
            await dataManager.logUnmatchedMagnet('N/A', threadData.title, threadUrl, reason);
        }
    }
}

// --- Worker main loop ---
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
