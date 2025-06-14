// src/index.js

const { runCrawler, scheduleCrawls } = require('./crawler/crawler');
const { startServer } = require('./addon');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redisClient = require('./database/redis');
require('./utils/trackers'); // Initialize tracker fetching
require('./utils/apiClient'); // Initialize resilient api client

async function main() {
    logger.info(`Main process ${process.pid} is starting...`);

    // --- START OF CHANGES ---
    if (config.PURGE_ON_START) {
        logger.warn('PURGE_ON_START is true. Clearing ENTIRE Redis database...');
        await redisClient.flushdb();
        logger.info('Redis database cleared.');
    } else if (config.PURGE_ORPHANS_ON_START) {
        // This is the new, selective purge
        logger.warn('PURGE_ORPHANS_ON_START is true. Clearing unmatched_magnets list...');
        await redisClient.del('unmatched_magnets');
        logger.info('Orphan magnet list cleared.');
    }
    // --- END OF CHANGES ---

    // Start the Stremio addon server immediately.
    startServer();

    // Run the initial crawl in the background.
    logger.info(`Starting initial crawl for ${config.INITIAL_PAGES} pages in the background...`);
    runCrawler(true).catch(err => {
        logger.error({ err }, "Initial crawler run failed.");
    });

    // Schedule subsequent crawls.
    scheduleCrawls();
}

main().catch(err => {
    logger.error({ err, stack: err.stack }, "A critical error occurred during application startup.");
    process.exit(1);
});
