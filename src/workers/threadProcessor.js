const { workerData, parentPort } = require('worker_threads');
const axios = require('axios');
const { parseThreadPage } = require('../parser/htmlParser');
const { parseTitle, normalizeTitle } = require('../parser/titleParser');
const dataManager = require('../database/dataManager');
const config =require('../utils/config');
const logger = require('../utils/logger');

async function processThread(threadUrl) {
    try {
        const html = await fetchThreadHtml(threadUrl);
        if (!html) {
            logger.error({ url: threadUrl }, "Failed to fetch thread HTML.");
            return { status: 'failed_fetch' };
        }

        const threadData = parseThreadPage(html, threadUrl);
        if (!threadData || threadData.magnets.length === 0) {
            logger.warn({ url: threadUrl }, "No magnets found on thread page or failed to parse.");
            await dataManager.updateThreadTimestamp(threadUrl); // Mark as visited
            return { status: 'no_magnets' };
        }

        const baseTitle = normalizeTitle(threadData.title);
        const yearMatch = threadData.title.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : null;

        if (!baseTitle || !year) {
             logger.warn({ originalTitle: threadData.title, url: threadUrl }, 'Could not determine base title or year. Skipping.');
             return { status: 'bad_title' };
        }

        // Movie Key: "tbs-" prefix + normalized title + year
        const movieKey = `tbs-${baseTitle}-${year}`;

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
        logger.info({ url: threadUrl, title: threadData.title, streams: streamsAdded }, "Successfully processed thread.");
        return { status: 'success', streamsAdded };

    } catch (error) {
        logger.error({ err: error.message, url: threadUrl, stack: error.stack }, 'Error processing thread');
        return { status: 'error' };
    }
}

async function fetchThreadHtml(url) {
    try {
        const { data } = await axios.get(url, { 
            headers: { 'User-Agent': config.USER_AGENT },
            timeout: 10000 
        });
        return data;
    } catch (error) {
        logger.error({ url, err: error.message }, 'Failed to fetch thread HTML');
        return null;
    }
}

(async () => {
    const { threadUrl } = workerData;
    const result = await processThread(threadUrl);
    if (parentPort) {
        parentPort.postMessage(result);
    } else {
        // This allows running the file directly for testing
        process.exit(0);
    }
})();
