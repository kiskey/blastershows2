// src/index.js

const { runCrawler, scheduleCrawls } = require('./crawler/crawler');
const { startServer } = require('./addon');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redisClient = require('./database/redis');
const dataManager = require('./database/dataManager');
require('./utils/trackers');
require('./utils/apiClient'); // Ensure apiClient is initialized

async function main() {
    logger.info(`Main process ${process.pid} is starting...`);

      // --- NEW: Load hints into Redis ---
    await dataManager.loadHintsIntoRedis();

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

    // Run the initial crawl and then the rescue job immediately after.
    (async () => {
        try {
            logger.info(`Starting initial crawl for ${config.INITIAL_PAGES} pages...`);
            await runCrawler(true); // Wait for the initial crawl to finish
            
            logger.info('Initial crawl complete. Running immediate orphan rescue job...');
            await dataManager.rescueOrphanedMagnets();
            logger.info('Immediate orphan rescue job finished.');
        } catch(err) {
            logger.error({ err }, "Initial startup sequence (crawl/rescue) failed.");
        }
    })();

    // Schedule subsequent background tasks
    scheduleCrawls(); // This schedules the recurring page crawl
    
    // This schedules the recurring orphan rescue
    setInterval(() => {
        dataManager.rescueOrphanedMagnets().catch(err => {
            logger.error({ err }, 'Scheduled orphan rescue job failed.');
        });
    }, 6 * 60 * 60 * 1000); // Every 6 hours
}

main().catch(err => {
    logger.error({ err, stack: err.stack }, "A critical error occurred during application startup.");
    process.exit(1);
});
