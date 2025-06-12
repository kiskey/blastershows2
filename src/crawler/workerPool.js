const { Worker } = require('worker_threads');
const logger = require('../utils/logger');

class WorkerPool {
    constructor(numThreads, workerPath) {
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.activeWorkers = new Set();
        this.taskQueue = [];
    }

    run(taskData) {
        this.taskQueue.push(taskData);
        this.tryStartWorker();
    }

    tryStartWorker() {
        if (this.taskQueue.length === 0 || this.activeWorkers.size >= this.numThreads) {
            return;
        }

        const taskData = this.taskQueue.shift();
        const worker = new Worker(this.workerPath, { workerData: taskData });
        this.activeWorkers.add(worker);

        logger.info(`Starting worker for thread: ${taskData.threadUrl}`);

        worker.on('message', (result) => {
            logger.info(`Worker finished task for ${taskData.threadUrl} with status: ${result.status}`);
        });

        worker.on('error', (error) => {
            logger.error({ err: error, url: taskData.threadUrl }, 'A worker encountered an error');
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn(`Worker for ${taskData.threadUrl} stopped with exit code ${code}`);
                // Optional: Re-queue the task
                // this.taskQueue.unshift(taskData);
            }
            this.activeWorkers.delete(worker);
            // Check if there are more tasks to process
            this.tryStartWorker();
        });
    }
}

module.exports = WorkerPool;
