// src/crawler/workerPool.js

const { Worker } = require('worker_threads');
const logger = require('../utils/logger');

class WorkerPool {
    constructor(numThreads, workerPath) {
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.workers = new Array(numThreads).fill(null);
        this.taskQueue = [];
    }

    /**
     * Adds a task to the queue and returns a Promise that resolves/rejects when the task is done.
     * @param {object} taskData - The data for the worker.
     * @returns {Promise<any>}
     */
    run(taskData) {
        return new Promise((resolve, reject) => {
            this.taskQueue.push({ data: taskData, resolve, reject, isSettled: false });
            this.processQueue();
        });
    }

    /**
     * The core loop. It checks for idle workers and available tasks,
     * and starts as many workers as possible.
     */
    processQueue() {
        while (this.taskQueue.length > 0) {
            const idleWorkerIndex = this.workers.findIndex(worker => worker === null);
            if (idleWorkerIndex === -1) {
                break; // All workers are busy
            }

            const task = this.taskQueue.shift();
            if (!task) continue;

            this.workers[idleWorkerIndex] = 'busy'; // Placeholder
            this.startWorker(idleWorkerIndex, task);
        }
    }

    /**
     * Starts a new worker for a given task and handles its lifecycle events.
     * @param {number} workerIndex - The slot index for the new worker.
     * @param {object} task - The task object containing data and promise handlers.
     */
    startWorker(workerIndex, task) {
        const worker = new Worker(this.workerPath, { workerData: task.data });
        this.workers[workerIndex] = worker;
        
        logger.info(`Starting worker #${workerIndex} for thread: ${task.data.threadUrl}`);

        const handleResult = (handler, result) => {
            if (!task.isSettled) {
                task.isSettled = true;
                handler(result);
            }
        };

        worker.on('message', (result) => {
            handleResult(task.resolve, result);
        });

        worker.on('error', (error) => {
            logger.error({ err: error, url: task.data.threadUrl }, `Worker #${workerIndex} encountered a critical error`);
            handleResult(task.reject, error);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn(`Worker #${workerIndex} for ${task.data.threadUrl} stopped with exit code ${code}`);
                // Only reject if the promise hasn't been settled yet (e.g., worker crashed before sending a message)
                handleResult(task.reject, new Error(`Worker stopped unexpectedly with exit code ${code}`));
            }
            
            // This worker slot is now free.
            this.workers[workerIndex] = null;
            
            // IMPORTANT: A worker has finished. We must re-run the main loop
            // to check for more tasks waiting in the queue.
            this.processQueue();
        });
    }
}

module.exports = WorkerPool;
