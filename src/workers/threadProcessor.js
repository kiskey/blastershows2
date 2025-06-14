// src/workers/threadProcessor.js

const { parentPort } = require('worker_threads');
const axios = require('axios');
const { parseThreadPage } = require('../parser/htmlParser');
const { parseTitle, normalizeBaseTitle } = require('../parser/titleParser');
const dataManager = require('../database/dataManager');
const { searchTv, getTvDetails } = require('../utils/tmdb');
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
            logger.warn({ originalTitle: threadData.title, url: threadUrl }, 'Could not determine a valid base title. Skipping.');
            return;
        }

        // 1. Find the TMDb ID for this show using our title search
        const tmdbResult = await searchTv(baseTitle, year);
        if (!tmdbResult || !tmdbResult.id) {
            logger.warn({ title: baseTitle, year }, "Could not find TMDb match, skipping thread.");
            return;
        }
        const tmdbId = tmdbResult.id;

        // 2. Get the full details from TMDb to find the corresponding IMDb ID
        const details = await getTvDetails(tmdbId);
        if (!details || !details.imdbId) {
            logger.warn({ tmdbId, title: baseTitle }, 'Could not get IMDb ID from TMDb details, cannot create mapping.');
            return;
        }
        const imdbId = details.imdbId;

        // 3. Create the show record in our DB, storing the IMDb -> TMDb mapping
        await dataManager.findOrCreateShow(tmdbId, imdbId);
        
        // 4. Add all found streams to this TMDb ID's stream list
        for (const magnetUri of threadData.magnets) {
            const parsedStream = parseTitle(magnetUri);
            if (parsedStream) {
                await dataManager.addStream(tmdbId, parsedStream);
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
