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

        // Process EACH magnet individually, as its title may differ from the thread title.
        for (const magnetUri of threadData.magnets) {
            // 1. Parse the magnet's own title first to get its specific info
            const parsedStream = parseTitle(magnetUri);
            if (!parsedStream) {
                logger.warn({ magnet: magnetUri, source: threadUrl }, 'Skipping malformed magnet URI.');
                continue; // Skip to the next magnet
            }

            const baseTitle = normalizeBaseTitle(parsedStream.name);
            const year = parsedStream.year;

            if (!baseTitle) {
                logger.warn({ magnetName: parsedStream.name }, 'Could not normalize a base title from magnet, logging as orphan.');
                await dataManager.logUnmatchedMagnet(magnetUri, parsedStream.name, threadUrl);
                continue;
            }
            
            let metaResult = { tmdbId: null, imdbId: null, poster: null, name: baseTitle, year: year };

            // 2. Check our cache first to avoid redundant API calls
            const cachedTmdbId = await dataManager.findCachedTmdbId(baseTitle, year);
            if (cachedTmdbId) {
                metaResult.tmdbId = cachedTmdbId;
                // We still need the IMDb ID for mapping, so we get details
                const details = await getTvDetails(cachedTmdbId);
                if (details) {
                    metaResult.imdbId = details.imdbId;
                    metaResult.poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
                    metaResult.name = details.name;
                    metaResult.year = details.first_air_date ? details.first_air_date.substring(0, 4) : year;
                }
            } else {
                // 3. If not in cache, perform the full API waterfall
                const tmdbSearch = await searchTv(baseTitle, year);
                if (tmdbSearch && tmdbSearch.id) {
                    const details = await getTvDetails(tmdbSearch.id);
                    if (details && details.imdbId) {
                        metaResult.tmdbId = details.tmdbId;
                        metaResult.imdbId = details.imdbId;
                        metaResult.poster = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null;
                        metaResult.name = details.name;
                        metaResult.year = details.first_air_date ? details.first_air_date.substring(0, 4) : year;
                    }
                }
                
                if (!metaResult.imdbId) {
                    const omdbSearch = await searchOmdb(baseTitle);
                    if (omdbSearch && omdbSearch.imdbId) {
                        metaResult.imdbId = omdbSearch.imdbId;
                        metaResult.poster = metaResult.poster || omdbSearch.poster;
                        metaResult.name = omdbSearch.title;
                        metaResult.year = omdbSearch.year;
                        
                        // Correctly use the found IMDb ID to get the TMDb ID
                        const details = await getTvDetails(metaResult.imdbId);
                        if(details && details.tmdbId) {
                            metaResult.tmdbId = details.tmdbId;
                        }
                    }
                }
            }

            // 4. Final check and store data
            if (metaResult.imdbId && metaResult.tmdbId) {
                await dataManager.findOrCreateShow(metaResult.tmdbId, metaResult.imdbId, baseTitle, year);
                await dataManager.updateCatalog(metaResult.imdbId, metaResult.name, metaResult.poster, metaResult.year);
                await dataManager.addStream(metaResult.tmdbId, parsedStream);
            } else {
                await dataManager.logUnmatchedMagnet(magnetUri, parsedStream.name, threadUrl);
            }
        }
        
        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        logger.error({ err: error.message, url: threadUrl }, 'Error processing thread');
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
