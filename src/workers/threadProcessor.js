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
        // Don't log a full error for common issues like 404s or timeouts
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
        // If fetching fails, just stop processing this thread.
        if (!html) {
            return;
        }

        const threadData = parseThreadPage(html, threadUrl);
        // If parsing fails or no magnets are found, update the timestamp and stop.
        if (!threadData || threadData.magnets.length === 0) {
            await dataManager.updateThreadTimestamp(threadUrl); 
            return;
        }

        const baseTitle = normalizeBaseTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle || !year) {
             logger.warn({ originalTitle: threadData.title, baseTitle, year, url: threadUrl }, 'Could not determine a valid base title or year. Skipping.');
             return;
        }

        const movieKey = `tbs-${baseTitle.replace(/\s+/g, '-')}-${year}`;

        // Create the main show entry in Redis
        await dataManager.findOrCreateShow(movieKey, threadData.title, threadData.posterUrl, year);

        // Process all magnets found on the page
        for (const magnetUri of threadData.magnets) {
            const parsedStream = parseTitle(magnetUri); 

            if (parsedStream) {
                await dataManager.addStream(movieKey, parsedStream);
            }
        }
        
        // Mark the thread as visited so it isn't re-crawled immediately
        await dataManager.updateThreadTimestamp(threadUrl);

    } catch (error) {
        // Log any unexpected errors during the process
        logger.error({ err: error.message, url: threadUrl, stack: error.stack }, 'Error processing thread');
    }
}

// This is the self-executing block that runs when the file is loaded as a worker.
(async () => {
    // Get the URL from the workerData object, which is now shaped as { url: '...' }
    const { url } = workerData; 

    if (url) {
        await processThread(url);
    }
    
    // After all work is done, we manually trigger garbage collection
    // to free up memory from large objects like the parsed HTML page.
    if (global.gc) {
        global.gc();
        logger.debug({ url }, 'Garbage collection triggered in worker.');
    }

    // We can post a simple message back to indicate we're done, though the 'exit' event is what the pool uses.
    if(parentPort) {
      parentPort.postMessage('done');
    }
})();
