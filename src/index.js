// src/index.js (Updated and Simplified)

const { runCrawler, scheduleCrawls } = require('./crawler/crawler');
const { startServer } = require('./addon');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redisClient = require('./database/redis');

// The entire application will run in a single process.
// The WorkerPool inside crawler.js will handle the actual concurrency using worker_threads.

async function main() {
    logger.info(`Main process ${process.pid} is starting...`);

    if (config.PURGE_ON_START) {
        logger.warn('PURGE_ON_START is true. Clearing Redis database...');
        await redisClient.flushdb();
        logger.info('Redis database cleared.');
    }

    // Start the Stremio addon server immediately so the app is responsive.
    startServer();

    // Run the initial crawl in the background.
    // We don't use 'await' here so the server starts without waiting for the crawl to finish.
    logger.info(`Starting initial crawl for ${config.INITIAL_PAGES} pages in the background...`);
    runCrawler(true);

    // Schedule subsequent crawls, which will also run in the background.
    scheduleCrawls();
}

// Run the main function and catch any fatal startup errors.
main().catch(err => {
    logger.error({ err, stack: err.stack }, "A critical error occurred during application startup.");
    process.exit(1);
});
