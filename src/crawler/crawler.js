// src/crawler/crawler.js

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
            timeout: 10000,
            headers: { 'User-Agent': config.USER_AGENT }
        });
        const finalUrl = response.request.res.responseUrl;
        const domain = new URL(finalUrl).origin;
        logger.info(`Master domain resolved to: ${domain}`);
        return url.replace(new URL(config.FORUM_URL).origin, domain);
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to resolve master domain. Using default FORUM_URL from config.');
        return config.FORUM_URL;
    }
}

async function fetchPage(url) {
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': config.USER_AGENT } });
        return data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null;
        }
        logger.error({ url, err: error.message }, 'Failed to fetch page');
        throw error;
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
    return [...new Set(links)];
}

async function runCrawler(isInitial = false) {
    logger.info('Crawler run starting...');
    const baseUrl = await getValidUrl(config.FORUM_URL);
    const maxPages = isInitial && config.INITIAL_PAGES > 0 ? config.INITIAL_PAGES : Infinity;
    let totalThreadsFound = 0;

    for (let i = 1; i <= maxPages; i++) {
        const pageUrl = `${baseUrl}page/${i}/`;
        logger.info(`Crawling page: ${pageUrl}`);
        
        try {
            const html = await fetchPage(pageUrl);
            if (!html) {
                logger.info('Reached the end of pagination.');
                break;
            }

            const threadUrls = parseThreadLinks(html);
            totalThreadsFound += threadUrls.length;
            logger.info(`Found ${threadUrls.length} threads on page ${i}. Adding to queue...`);

            // Add all tasks to the pool. The pool will manage starting them.
            threadUrls.forEach(url => workerPool.run({ url }));

            await new Promise(resolve => setTimeout(resolve, 500)); 

        } catch (error) {
            logger.error({ page: i, err: error.message }, 'Failed to process a page. Moving to the next one.');
            continue;
        }
    }
    
    logger.info(`Crawler page discovery finished. Total threads queued: ${totalThreadsFound}. Waiting for all workers to complete...`);
    // Use the new, simpler wait() method.
    await workerPool.wait();
    logger.info('All worker tasks have been completed. Crawler run is fully finished.');
}

async function revisitOldThreads() {
    logger.info('Checking for old threads to revisit...');
    const threadsToRevisit = await dataManager.getThreadsToRevisit();
    if (threadsToRevisit.length > 0) {
        logger.info(`Revisiting ${threadsToRevisit.length} old threads.`);
        threadsToRevisit.forEach(url => workerPool.run({ url }));
        await workerPool.wait();
        logger.info('Old thread revisit complete.');
    } else {
        logger.info('No old threads require revisiting at this time.');
    }
}

function scheduleCrawls() {
    let isCrawlingNewContent = false;
    let isRevisitingOld = false;

    setInterval(async () => {
        if (isCrawlingNewContent) {
            logger.warn('New content crawl is already in progress. Skipping this interval.');
            return;
        }
        isCrawlingNewContent = true;
        try {
            logger.info('Scheduler: Kicking off new content crawl.');
            await runCrawler(true);
        } catch (err) {
            logger.error({ err }, "Scheduled crawl failed.");
        } finally {
            isCrawlingNewContent = false;
        }
    }, config.CRAWL_INTERVAL * 1000);

    setInterval(async ().
        if (isRevisitingOld) {
            logger.warn('Old thread revisit is already in progress. Skipping this interval.');
            return;
        }
        isRevisitingOld = true;
        try {
            logger.info('Scheduler: Kicking off old thread revisit check.');
            await revisitOldThreads();
        } catch (err) {
            logger.error({ err }, "Scheduled revisit failed.");
        } finally {
            isRevisitingOld = false;
        }
    }, 60 * 60 * 1000);
}

module.exports = { runCrawler, scheduleCrawls };
