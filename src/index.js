// src/index.js

const { runCrawler, scheduleCrawls } = require('./crawler/crawler');
const { startServer } = require('./addon');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redisClient = require('./database/redis');
const dataManager = require('./database/dataManager'); // Import dataManager
require('./utils/trackers');
require('./utils/apiClient');

async function main() {
    logger.info(`Main process ${process.pid} is starting...`);

    if (config.PURGE_ON_START) {
        logger.warn('PURGE_ON_START is true. Clearing ENTIRE Redis database...');
        await redisClient.flushdb();
        logger.info('Redis database cleared.');
    } else if (config.PURGE_ORPHANS_ON_START) {
        logger.warn('PURGE_ORPHANS_ON_START is true. Clearing unmatched_magnets list...');
        await redisClient.del('unmatched_magnets');
        logger.info('Orphan magnet list cleared.');
    }

    startServer();

    logger.info(`Starting initial crawl for ${config.INITIAL_PAGES} pages in the background...`);
    runCrawler(true).catch(err => {
        logger.error({ err }, "Initial crawler run failed.");
    });

    scheduleCrawls();

    // --- START OF NEW SCHEDULER ---
    // Schedule the orphan rescue job to run periodically (e.g., every 6 hours)
    setInterval(() => {
        dataManager.rescueOrphanedMagnets().catch(err => {
            logger.error({ err }, 'Orphan rescue job failed.');
        });
    }, 6 * 60 * 60 * 1000); // 6 hours
    // --- END OF NEW SCHEDULER ---
}

main().catch(err => {
    logger.error({ err, stack: err.stack }, "A critical error occurred during application startup.");
    process.exit(1);
});
