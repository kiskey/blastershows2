// src/workers/threadProcessor.js

const { parentPort } = require('worker_threads');
const axios = require('axios');
const { parseThreadPage } = require('../parser/htmlParser');
const { parseTitle, normalizeBaseTitle } = require('../parser/titleParser');
const dataManager = require('../database/dataManager');
const config = require('../utils/config');
const logger = require('../utils/logger');

// --- Helper Functions (remain the same) ---
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

        if (!baseTitle || !year) {
            logger.warn({ originalTitle: threadData.title, baseTitle, year, url: threadUrl }, 'Could not determine a valid base title or year. Skipping.');
            return;
        }

        const movieKey = `tbs-${baseTitle.replace(/\s+/g, '-')}-${year}`;
        await dataManager.findOrCreateShow(movieKey, threadData.title, threadData.posterUrl, year);

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

// --- Main Worker Loop ---
async function main() {
    // Listen for tasks from the main thread
    parentPort.on('message', async (task) => {
        if (task && task.url) {
            logger.debug({ url: task.url }, `Worker received task.`);
            await processThread(task.url);

            // Trigger garbage collection after processing
            if (global.gc) {
                global.gc();
            }

            // Signal that this worker has completed its task and is ready for more.
            parentPort.postMessage('done');
        }
    });

    // Signal that the worker has initialized and is ready for its first task.
    parentPort.postMessage('ready');
}

main().catch(err => {
    logger.error({ err }, 'Worker main loop crashed');
    // In case of a crash, try to signal completion so the pool can recover.
    parentPort.postMessage('done');
});
