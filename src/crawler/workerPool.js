// src/crawler/workerPool.js

const { Worker } = require('worker_threads');
const logger = require('../utils/logger');

class WorkerPool {
    constructor(numThreads, workerPath) {
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.workers = new Array(numThreads).fill(null); // Tracks active worker instances
        this.taskQueue = []; // Holds tasks waiting for an available worker
    }

    /**
     * Accepts a task and returns a Promise that resolves when the task is complete.
     * @param {object} taskData - The data to pass to the worker.
     * @returns {Promise<any>}
     */
    run(taskData) {
        return new Promise((resolve, reject) => {
            // Package the task data with its promise handlers
            const task = { data: taskData, resolve, reject };
            this.taskQueue.push(task);
            this.tryStartWorker();
        });
    }

    /**
     * Checks for idle workers and available tasks, then starts a worker if both exist.
     */
    tryStartWorker() {
        if (this.taskQueue.length === 0) {
            return; // No tasks to process
        }
        
        // Find an available slot for a worker
        const idleWorkerIndex = this.workers.findIndex(worker => worker === null);
        if (idleWorkerIndex === -1) {
            // All workers are currently busy. They will automatically pick up new tasks when they finish.
            return;
        }

        const task = this.taskQueue.shift();
        if (!task) return;

        const worker = new Worker(this.workerPath, { workerData: task.data });
        this.workers[idleWorkerIndex] = worker; // Assign the worker to the slot

        logger.info(`Starting worker #${idleWorkerIndex} for thread: ${task.data.threadUrl}`);

        worker.on('message', (result) => {
            task.resolve(result); // Resolve the promise for this specific task
        });

        worker.on('error', (error) => {
            logger.error({ err: error, url: task.data.threadUrl }, `Worker #${idleWorkerIndex} encountered a critical error`);
            task.reject(error); // Reject the promise on error
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn(`Worker #${idleWorkerIndex} for ${task.data.threadUrl} stopped with exit code ${code}`);
                // If a worker exits unexpectedly, you might want to reject its promise
                // if it hasn't been resolved or rejected yet.
                task.reject(new Error(`Worker stopped with exit code ${code}`));
            }
            // The worker is done, so its slot is now free
            this.workers[idleWorkerIndex] = null; 
            
            // Check if there are more tasks in the queue to process with this now-idle slot
            this.tryStartWorker();
        });
    }
}

module.exports = WorkerPool;
