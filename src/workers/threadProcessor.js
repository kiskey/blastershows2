// src/workers/threadProcessor.js

const { parentPort } = require('worker_threads');
const axios = require('axios');
const { parseThreadPage } = require('../parser/htmlParser');
const { parseTitle, normalizeBaseTitle } = require('../parser/titleParser');
const dataManager = require('../database/dataManager');
const { searchTv } = require('../utils/tmdb');
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

        // --- NEW METADATA LOGIC ---
        // 1. Find the TMDb ID for this show
        const tmdbResult = await searchTv(baseTitle, year);
        if (!tmdbResult || !tmdbResult.id) {
            logger.warn({ title: baseTitle, year }, "Could not find TMDb match, cannot process this show.");
            return;
        }
        const tmdbId = tmdbResult.id;

        // 2. Create the show record mapping our internal name to the tmdbId
        await dataManager.findOrCreateShow(baseTitle, year, tmdbId);
        
        // 3. Add all streams to this TMDb ID's stream list
        for (const magnetUri of threadData.magnets) {
            const parsedStream = parseTitle(magnetUri);
            if (parsedStream) {
                // Pass the TMDb ID to the addStream function
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
        logger.debug({ url: task.url }, `Worker received task.`);
        await processThread(task.url);

        if (global.gc) {
            global.gc();
        }

        parentPort.postMessage('done');
    }
});

parentPort.postMessage('ready');
