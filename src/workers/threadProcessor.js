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

        const baseTitle = normalizeBaseTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle) {
            logger.warn({ originalTitle: threadData.title, url: threadUrl }, 'Could not determine a valid base title.');
            return;
        }

        let metaResult = { tmdbId: null, imdbId: null, poster: null, name: baseTitle, year: year };

        // --- METADATA WATERFALL ---
        // 1. Try TMDb first
        const tmdbSearch = await searchTv(baseTitle, year);
        if (tmdbSearch && tmdbSearch.id) {
            const details = await getTvDetails(tmdbSearch.id);
            if (details && details.imdbId) {
                metaResult.tmdbId = details.tmdbId;
                metaResult.imdbId = details.imdbId;
                metaResult.poster = tmdbSearch.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbSearch.poster_path}` : null;
                metaResult.name = tmdbSearch.name;
                // Use the year from TMDb if available as it's more accurate
                metaResult.year = tmdbSearch.first_air_date ? tmdbSearch.first_air_date.substring(0, 4) : year;
            }
        }

        // 2. If TMDb failed to produce a full result, fallback to OMDb
        if (!metaResult.imdbId) {
            logger.info({ title: baseTitle }, 'TMDb lookup incomplete, falling back to OMDb.');
            const omdbSearch = await searchOmdb(baseTitle);
            if (omdbSearch && omdbSearch.imdbId) {
                metaResult.imdbId = omdbSearch.imdbId;
                metaResult.poster = metaResult.poster || omdbSearch.poster; // Only use OMDb poster if TMDb didn't provide one
                metaResult.name = omdbSearch.title;
                metaResult.year = omdbSearch.year;
                
                // We have a reliable IMDb ID, but we still prefer a TMDb ID as our primary key.
                // We attempt to get the TMDb ID from the IMDb ID.
                const details = await getTvDetails(metaResult.imdbId);
                if (details && details.tmdbId) {
                    metaResult.tmdbId = details.tmdbId;
                }
            }
        }

        // 3. Final check: We need an IMDb ID to be a provider and a TMDb ID to store streams.
        if (!metaResult.imdbId || !metaResult.tmdbId) {
            logger.warn({ title: baseTitle }, "Could not resolve show to a valid TMDb/IMDb ID pair after all fallbacks.");
            return;
        }

        // 4. We have a valid result. Store everything.
        await dataManager.findOrCreateShow(metaResult.tmdbId, metaResult.imdbId);
        await dataManager.updateCatalog(metaResult.imdbId, metaResult.name, metaResult.poster, metaResult.year);
        
        for (const magnetUri of threadData.magnets) {
            const parsedStream = parseTitle(magnetUri);
            if (parsedStream) {
                await dataManager.addStream(metaResult.tmdbId, parsedStream);
            }
        }
        
        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        logger.error({ err: error.message, url: threadUrl, stack: error.stack }, 'Error processing thread');
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
