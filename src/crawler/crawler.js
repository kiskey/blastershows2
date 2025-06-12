const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../utils/config');
const logger = require('../utils/logger');
const WorkerPool = require('./workerPool');
const dataManager = require('../database/dataManager');

const workerPool = new WorkerPool(config.MAX_CONCURRENCY, './src/workers/threadProcessor.js');

async function getValidUrl(url) {
    try {
        const response = await axios.get(config.DOMAIN_MONITOR, {
            maxRedirects: 5,
            timeout: 5000,
            headers: { 'User-Agent': config.USER_AGENT }
        });
        const finalUrl = response.request.res.responseUrl;
        const domain = new URL(finalUrl).origin;
        logger.info(`Master domain resolved to: ${domain}`);
        return url.replace(new URL(config.FORUM_URL).origin, domain);
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to resolve master domain. Using default FORUM_URL.');
        return config.FORUM_URL;
    }
}

async function fetchPage(url) {
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': config.USER_AGENT } });
        return data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null; // Page not found, end of pagination
        }
        logger.error({ url, err: error.message }, 'Failed to fetch page');
        throw error; // Rethrow for backoff handling
    }
}

function parseThreadLinks(html) {
    const $ = cheerio.load(html);
    const links = [];
    $('a[data-ipshover]').each((i, el) => {
        const link = $(el).attr('href');
        if (link && link.includes('/topic/')) {
            links.push(link);
        }
    });
    return [...new Set(links)]; // Deduplicate links
}

async function runCrawler(isInitial = false) {
    const baseUrl = await getValidUrl(config.FORUM_URL);
    const maxPages = isInitial && config.INITIAL_PAGES > 0 ? config.INITIAL_PAGES : Infinity;

    for (let i = 1; i <= maxPages; i++) {
        const pageUrl = `${baseUrl}page/${i}/`;
        logger.info(`Crawling page: ${pageUrl}`);
        const html = await fetchPage(pageUrl);

        if (!html) {
            logger.info('Reached the end of pagination.');
            break;
        }

        const threadUrls = parseThreadLinks(html);
        logger.info(`Found ${threadUrls.length} threads on page ${i}`);

        for (const threadUrl of threadUrls) {
            workerPool.run({ threadUrl });
        }
        await new Promise(resolve => setTimeout(resolve, 250)); // Throttle requests
    }
    logger.info('Crawler run finished.');
}

async function revisitOldThreads() {
    logger.info('Checking for old threads to revisit...');
    const threadsToRevisit = await dataManager.getThreadsToRevisit();
    if (threadsToRevisit.length > 0) {
        logger.info(`Revisiting ${threadsToRevisit.length} old threads.`);
        for (const threadUrl of threadsToRevisit) {
            workerPool.run({ threadUrl });
        }
    } else {
        logger.info('No old threads require revisiting at this time.');
    }
}

function scheduleCrawls() {
    // New content check
    setInterval(() => {
        logger.info('Scheduler: Kicking off new content crawl.');
        runCrawler(true); // Always treat scheduled crawls as "initial" to check first few pages
    }, config.CRAWL_INTERVAL * 1000);

    // Old thread revisit check (every hour)
    setInterval(() => {
        logger.info('Scheduler: Kicking off old thread revisit check.');
        revisitOldThreads();
    }, 60 * 60 * 1000);
}

module.exports = { runCrawler, scheduleCrawls };
