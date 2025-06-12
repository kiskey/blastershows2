// src/crawler/workerPool.js (Updated)
const { Worker } = require('worker_threads');
const logger = require('../utils/logger');

class WorkerPool {
    constructor(numThreads, workerPath) {
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.workers = new Array(numThreads).fill(null);
        this.taskQueue = [];
    }

    run(taskData) {
        return new Promise((resolve, reject) => {
            const task = { data: taskData, resolve, reject };
            this.taskQueue.push(task);
            this.tryStartWorker();
        });
    }

    tryStartWorker() {
        if (this.taskQueue.length === 0) {
            return;
        }
        
        const idleWorkerIndex = this.workers.findIndex(worker => worker === null);
        if (idleWorkerIndex === -1) {
            // All workers are busy, they will pick up tasks when they are done.
            return;
        }

        const task = this.taskQueue.shift();
        if (!task) return;

        const worker = new Worker(this.workerPath, { workerData: task.data });
        this.workers[idleWorkerIndex] = worker;

        logger.info(`Starting worker #${idleWorkerIndex} for thread: ${task.data.threadUrl}`);

        worker.on('message', (result) => {
            logger.info(`Worker #${idleWorkerIndex} finished task for ${task.data.threadUrl} with status: ${result.status}`);
            task.resolve(result); // Resolve the promise for this task
        });

        worker.on('error', (error) => {
            logger.error({ err: error, url: task.data.threadUrl }, `Worker #${idleWorkerIndex} encountered an error`);
            task.reject(error); // Reject the promise
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn(`Worker #${idleWorkerIndex} for ${task.data.threadUrl} stopped with exit code ${code}`);
                // Optional: Re-queue the task if it failed unexpectedly
                // this.taskQueue.unshift(task);
            }
            this.workers[idleWorkerIndex] = null; // Mark worker as idle
            // Check if there are more tasks to process
            this.tryStartWorker();
        });
    }
}

module.exports = WorkerPool;
