// src/workers/threadProcessor.js

const { workerData, parentPort } = require('worker_threads');
const axios = require('axios');
const { parseThreadPage } = require('../parser/htmlParser');
// Use the new, renamed normalizeBaseTitle function
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
        logger.error({ url, err: error.message }, 'Failed to fetch thread HTML');
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
        if (!html) {
            return { status: 'failed_fetch' };
        }

        const threadData = parseThreadPage(html, threadUrl);
        if (!threadData || threadData.magnets.length === 0) {
            logger.warn({ url: threadUrl }, "No magnets found on thread page or failed to parse.");
            // Mark as visited even if no magnets are found to avoid re-crawling immediately
            await dataManager.updateThreadTimestamp(threadUrl); 
            return { status: 'no_magnets' };
        }

        // Use the new, more accurate normalization on the main thread title
        const baseTitle = normalizeBaseTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle || !year) {
             logger.warn({ originalTitle: threadData.title, baseTitle, year, url: threadUrl }, 'Could not determine a valid base title or year. Skipping.');
             return { status: 'bad_title' };
        }

        // Create a clean movie key (e.g., tbs-mercy-for-none-2025)
        const movieKey = `tbs-${baseTitle.replace(/\s+/g, '-')}-${year}`;

        // Create the main show entry in Redis
        const show = await dataManager.findOrCreateShow(movieKey, threadData.title, threadData.posterUrl, year);

        let streamsAdded = 0;
        // IMPORTANT: Iterate through ALL magnets found on the page
        for (const magnetUri of threadData.magnets) {
            // parseTitle will extract season, episode, quality, etc. from this specific magnet
            const parsedStream = parseTitle(magnetUri); 

            if (parsedStream) {
                // The dataManager will handle adding this as one or more streams to the movieKey
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

// This is the self-executing block that runs when the file is loaded as a worker.
(async () => {
    // This line will now work correctly because cluster is removed
    // and this script is only ever run by the WorkerPool.
    const { threadUrl } = workerData; 

    // Process the thread and post the result back to the main thread.
    const result = await processThread(threadUrl);

    if (parentPort) {
        parentPort.postMessage(result);
    } else {
        // This allows running the file directly for testing, then exits.
        process.exit(0);
    }
})();
