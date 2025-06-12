// src/workers/threadProcessor.js

const { workerData, parentPort } = require('worker_threads');
const axios = require('axios');
const { parseThreadPage } = require('../parser/htmlParser');
const { parseTitle, normalizeBaseTitle } = require('../parser/titleParser');
const dataManager = require('../database/dataManager');
const config = require('../utils/config');
const logger = require('../utils/logger');

/**
 * Fetches the HTML content of a given thread URL.
 * @param {string} url - The URL of the thread to fetch.
 * @returns {Promise<string|null>} The HTML content or null on failure.
 */
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

/**
 * The main processing function for a single thread.
 * It fetches, parses, and stores data in Redis.
 * @param {string} threadUrl - The URL of the forum thread.
 */
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
        
        // Use 'nya' (No Year Available) as a placeholder if year is not found.
        // This makes the movieKey consistent and sortable.
        const year = yearMatch ? yearMatch[0] : 'nya';

        if (!baseTitle) {
            logger.warn({ originalTitle: threadData.title, url: threadUrl }, 'Could not determine a valid base title. Skipping.');
            return;
        }

        const movieKey = `tbs-${baseTitle.replace(/\s+/g, '-')}-${year}`;

        // Pass the original year (or null if not found) to the dataManager for storage.
        const originalYear = year === 'nya' ? null : year;
        await dataManager.findOrCreateShow(movieKey, threadData.title, threadData.posterUrl, originalYear);

        for (const magnetUri of threadData.magnets) {
            const parsedStream = parseTitle(magnetUri);
            if (parsedStream) {
                await dataManager.addStream(movieKey, parsedStream);
            }
        }

        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        logger.error({ err: error.message, url: threadUrl, stack: error.stack }, 'Error processing thread');
    }
}

// This is the self-executing block that runs when the file is loaded as a worker.
(async () => {
    const { url } = workerData;
    if (url) {
        await processThread(url);
    }

    // After all work is done, manually trigger garbage collection.
    if (global.gc) {
        global.gc();
        logger.debug({ url }, 'Garbage collection triggered in worker.');
    }

    // Post a simple message back to indicate the task is complete.
    if (parentPort) {
        parentPort.postMessage('done');
    }
})();
