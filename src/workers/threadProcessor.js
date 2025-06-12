// src/workers/threadProcessor.js

const { workerData, parentPort } = require('worker_threads');
const axios = require('axios');
const { parseThreadPage } = require('../parser/htmlParser');
const { parseTitle, normalizeBaseTitle } = require('../parser/titleParser'); 
const dataManager = require('../database/dataManager');
const config = require('../utils/config');
const logger = require('../utils/logger');

// ... (fetchThreadHtml and processThread functions remain the same) ...
async function fetchThreadHtml(url) {
    try {
        const { data } = await axios.get(url, { 
            headers: { 'User-Agent': config.USER_AGENT },
            timeout: 15000 
        });
        return data;
    } catch (error) {
        logger.error({ url, err: error.message }, 'Failed to fetch thread HTML');
        return null;
    }
}

async function processThread(threadUrl) {
    try {
        const html = await fetchThreadHtml(threadUrl);
        if (!html) {
            return { status: 'failed_fetch' };
        }

        const threadData = parseThreadPage(html, threadUrl);
        if (!threadData || threadData.magnets.length === 0) {
            await dataManager.updateThreadTimestamp(threadUrl); 
            return { status: 'no_magnets' };
        }

        const baseTitle = normalizeBaseTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle || !year) {
             logger.warn({ originalTitle: threadData.title, baseTitle, year, url: threadUrl }, 'Could not determine a valid base title or year. Skipping.');
             return { status: 'bad_title' };
        }

        const movieKey = `tbs-${baseTitle.replace(/\s+/g, '-')}-${year}`;

        const show = await dataManager.findOrCreateShow(movieKey, threadData.title, threadData.posterUrl, year);

        let streamsAdded = 0;
        for (const magnetUri of threadData.magnets) {
            const parsedStream = parseTitle(magnetUri); 

            if (parsedStream) {
                await dataManager.addStream(show.id, parsedStream);
                streamsAdded++;
            }
        }
        
        await dataManager.updateThreadTimestamp(threadUrl);
        logger.info({ url: threadUrl, title: baseTitle, movieKey, magnets_processed: streamsAdded }, "Successfully processed thread.");
        return { status: 'success', streamsAdded };

    } catch (error) {
        logger.error({ err: error.message, url: threadUrl, stack: error.stack }, 'Error processing thread');
        return { status: 'error' };
    }
}


(async () => {
    const { threadUrl } = workerData; 
    const result = await processThread(threadUrl);

    if (parentPort) {
        parentPort.postMessage(result);
    }

    // ---- THIS IS THE CHANGE ----
    // After all work is done and the result is posted,
    // we manually trigger garbage collection before the worker exits.
    if (global.gc) {
        global.gc();
        logger.debug({ url: threadUrl }, 'Garbage collection triggered in worker.');
    }
    // ---- END OF CHANGE ----
})();
