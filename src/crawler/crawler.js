// src/crawler/crawler.js

const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../utils/config');
const logger = require('../utils/logger');
const WorkerPool = require('./workerPool');
const dataManager = require('../database/dataManager');

// The worker path is relative to the project root
const workerPool = new WorkerPool(config.MAX_CONCURRENCY, './src/workers/threadProcessor.js');

/**
 * Resolves the master domain to handle redirects and domain changes.
 * @param {string} url - The initial URL from config.
 * @returns {Promise<string>} The updated and valid base URL.
 */
async function getValidUrl(url) {
    try {
        const response = await axios.get(config.DOMAIN_MONITOR, {
            maxRedirects: 5,
            timeout: 10000, // Increased timeout for reliability
            headers: { 'User-Agent': config.USER_AGENT }
        });
        // response.request.res.responseUrl contains the final URL after all redirects
        const finalUrl = response.request.res.responseUrl;
        const domain = new URL(finalUrl).origin;
        logger.info(`Master domain resolved to: ${domain}`);
        // Replace the domain in the original FORUM_URL with the new, valid one
        return url.replace(new URL(config.FORUM_URL).origin, domain);
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to resolve master domain. Using default FORUM_URL from config.');
        return config.FORUM_URL;
    }
}

/**
 * Fetches the HTML content of a single forum page.
 * @param {string} url - The page URL to fetch.
 * @returns {Promise<string|null>} HTML content or null on 404.
 */
async function fetchPage(url) {
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': config.USER_AGENT } });
        return data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null; // Page not found, which is the expected end of pagination
        }
        logger.error({ url, err: error.message }, 'Failed to fetch page');
        throw error; // Rethrow other errors to be handled by the caller
    }
}

/**
 * Parses a forum page to extract all unique thread links.
 * @param {string} html - The HTML content of the page.
 * @returns {string[]} An array of unique thread URLs.
 */
function parseThreadLinks(html) {
    const $ = cheerio.load(html);
    const links = [];
    // The selector finds links that have the 'data-ipshover' attribute, which is common for topic links
    $('a[data-ipshover]').each((i, el) => {
        const link = $(el).attr('href');
        // Ensure the link is valid and points to a topic
        if (link && link.includes('/topic/')) {
            links.push(link);
        }
    });
    return [...new Set(links)]; // Use a Set to automatically handle duplicates, then convert back to an array
}

/**
 * The main crawler function that iterates through pages and dispatches threads to the worker pool.
 * @param {boolean} isInitial - Whether this is the first run on startup.
 */
async function runCrawler(isInitial = false) {
    logger.info('Crawler run starting...');
    const baseUrl = await getValidUrl(config.FORUM_URL);
    const maxPages = isInitial && config.INITIAL_PAGES > 0 ? config.INITIAL_PAGES : Infinity;

    for (let i = 1; i <= maxPages; i++) {
        const pageUrl = `${baseUrl}page/${i}/`;
        logger.info(`Crawling page: ${pageUrl}`);
        
        try {
            const html = await fetchPage(pageUrl);
            if (!html) {
                logger.info('Reached the end of pagination.');
                break; // Exit the loop if a page returns 404
            }

            const threadUrls = parseThreadLinks(html);
            logger.info(`Found ${threadUrls.length} threads on page ${i}. Dispatching to worker pool...`);

            // Use Promise.all to dispatch all tasks. The worker pool processes them concurrently.
            const tasks = threadUrls.map(threadUrl => workerPool.run({ threadUrl }));
            await Promise.all(tasks);

            logger.info(`All ${threadUrls.length} threads from page ${i} have been queued for processing.`);

            // Throttle requests between fetching pages to be a good web citizen
            await new Promise(resolve => setTimeout(resolve, 500)); 

        } catch (error) {
            logger.error({ page: i, err: error.message }, 'Failed to process a page. Moving to the next one.');
            continue; // Continue to the next page even if one fails
        }
    }
    logger.info('Crawler page discovery finished. Workers may still be processing in the background.');
}

/**
 * Finds and re-queues threads that haven't been visited in a while.
 */
async function revisitOldThreads() {
    logger.info('Checking for old threads to revisit...');
    const threadsToRevisit = await dataManager.getThreadsToRevisit();
    if (threadsToRevisit.length > 0) {
        logger.info(`Revisiting ${threadsToRevisit.length} old threads.`);
        const tasks = threadsToRevisit.map(threadUrl => workerPool.run({ threadUrl }));
        await Promise.all(tasks);
    } else {
        logger.info('No old threads require revisiting at this time.');
    }
}

/**
 * Sets up the recurring schedules for crawling new content and revisiting old threads.
 */
function scheduleCrawls() {
    // New content check (e.g., every 30 minutes)
    setInterval(() => {
        logger.info('Scheduler: Kicking off new content crawl.');
        // This will only crawl the first few pages as defined by INITIAL_PAGES
        runCrawler(true); 
    }, config.CRAWL_INTERVAL * 1000);

    // Old thread revisit check (e.g., every hour)
    setInterval(() => {
        logger.info('Scheduler: Kicking off old thread revisit check.');
        revisitOldThreads();
    }, 60 * 60 * 1000);
}

module.exports = { runCrawler, scheduleCrawls };
