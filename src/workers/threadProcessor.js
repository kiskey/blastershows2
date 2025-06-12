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
        const year = yearMatch ? yearMatch[0] : 'nya';

        if (!baseTitle) {
            logger.warn({ originalTitle: threadData.title, url: threadUrl }, 'Could not determine a valid base title. Skipping.');
            return;
        }

        const movieKey = `tbs-${baseTitle.replace(/\s+/g, '-')}-${year}`;
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

// --- THIS IS THE CORRECTED MAIN WORKER LOGIC ---
if (!parentPort) {
    // Should not happen in production, but good for safety
    process.exit();
}

// 1. Listen for tasks from the main thread (the pool)
parentPort.on('message', async (task) => {
    // Ensure we have a valid task object with a URL
    if (task && task.url) {
        logger.debug({ url: task.url }, `Worker received task.`);
        
        // 2. Do the work
        await processThread(task.url);

        // 3. Trigger garbage collection after processing
        if (global.gc) {
            global.gc();
        }

        // 4. Signal that this worker has completed its task and is ready for more.
        parentPort.postMessage('done');
    }
});

// 5. Signal that the worker has initialized and is ready for its *first* task.
parentPort.postMessage('ready');
