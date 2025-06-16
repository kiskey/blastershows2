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
    try {
        const html = await fetchThreadHtml(threadUrl);
        if (!html) return;

        const threadData = parseThreadPage(html, threadUrl);
        if (!threadData || threadData.magnets.length === 0) {
            await dataManager.updateThreadTimestamp(threadUrl);
            return;
        }

        // --- THE CORRECT LOGIC RESTORED ---
        // 1. Get the base title and year ONCE from the clean THREAD TITLE.
        const baseTitle = normalizeBaseTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle) {
            logger.warn({ threadTitle: threadData.title }, 'Could not normalize a base title from thread.');
            // This thread is unmatchable, log all its magnets as orphans
            for (const magnetUri of threadData.magnets) {
                await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl);
            }
            return;
        }

        let metaResult = { tmdbId: null, imdbId: null, poster: null, name: baseTitle, year: year };

        // 2. Check our cache for this title to avoid API calls
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
            // 3. If not cached, perform the full API waterfall
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

        // 4. Final check and store data
        if (metaResult.imdbId && metaResult.tmdbId) {
            await dataManager.findOrCreateShow(metaResult.tmdbId, metaResult.imdbId, baseTitle, year);
            await dataManager.updateCatalog(metaResult.imdbId, metaResult.name, metaResult.poster, metaResult.year);
            // NOW, loop through the magnets and add them to the TMDb ID we just found.
            for (const magnetUri of threadData.magnets) {
                const parsedStream = parseTitle(magnetUri);
                if (parsedStream) {
                    await dataManager.addStream(metaResult.tmdbId, parsedStream);
                }
            }
        } else {
            logger.warn({ title: baseTitle }, "Could not resolve show via APIs. Logging magnets as orphans.");
            for (const magnetUri of threadData.magnets) {
                await dataManager.logUnmatchedMagnet(magnetUri, threadData.title, threadUrl);
            }
        }
        
        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        logger.error({ err: error.message, url: threadUrl }, 'Error processing thread');
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
