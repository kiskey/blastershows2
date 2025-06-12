const cluster = require('cluster');
const os = require('os');
const { runCrawler, scheduleCrawls } = require('./crawler/crawler');
const { startServer } = require('./addon');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redisClient = require('./database/redis');

const numCPUs = os.cpus().length;
const maxWorkers = Math.min(numCPUs, config.MAX_CONCURRENCY);

if (cluster.isPrimary) {
    logger.info(`Primary ${process.pid} is running`);
    logger.info(`Forking ${maxWorkers} workers.`);

    // Fork workers.
    for (let i = 0; i < maxWorkers; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        logger.warn(`Worker ${worker.process.pid} died. Forking another one...`);
        cluster.fork();
    });

    // The primary process will handle scheduling and the API server
    (async () => {
        if (config.PURGE_ON_START) {
            logger.warn('PURGE_ON_START is true. Clearing Redis database...');
            await redisClient.flushdb();
            logger.info('Redis database cleared.');
        }

        // Run initial crawl immediately
        logger.info(`Starting initial crawl for ${config.INITIAL_PAGES} pages...`);
        await runCrawler(true); // isInitial = true

        // Schedule subsequent crawls
        scheduleCrawls();

        // Start the Stremio addon server
        startServer();
    })();

} else {
    // This is a worker process. It will process tasks from the worker pool.
    // The worker pool logic is implicitly handled by `worker_threads`
    // but the clustering here helps distribute the load of thread processing.
    require('./workers/threadProcessor');
    logger.info(`Worker ${process.pid} started`);
}
