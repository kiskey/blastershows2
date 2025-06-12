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
            this.taskQueue.push({ data: taskData, resolve, reject });
            this.processQueue(); // Attempt to process the queue immediately
        });
    }

    /**
     * This is the core loop. It checks for idle workers and available tasks,
     * and starts as many workers as possible.
     */
    processQueue() {
        // Iterate while there are tasks in the queue AND there are idle worker slots
        while (this.taskQueue.length > 0) {
            const idleWorkerIndex = this.workers.findIndex(worker => worker === null);
            
            if (idleWorkerIndex === -1) {
                // No idle workers available, break the loop.
                // The 'exit' handler of a running worker will re-trigger this loop later.
                break; 
            }

            const task = this.taskQueue.shift();
            if (!task) continue;

            // Mark the slot as busy immediately
            this.workers[idleWorkerIndex] = 'busy'; // Use a placeholder to prevent race conditions

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
        
        // Assign the actual worker instance to the slot
        this.workers[workerIndex] = worker;
        
        logger.info(`Starting worker #${workerIndex} for thread: ${task.data.threadUrl}`);

        worker.on('message', (result) => {
            task.resolve(result);
        });

        worker.on('error', (error) => {
            logger.error({ err: error, url: task.data.threadUrl }, `Worker #${workerIndex} encountered a critical error`);
            task.reject(error);
        });

        worker.on('exit', (code) => {
            if (code !== 0 && !task.resolved) {
                // If the worker exited with an error and the promise wasn't already handled
                logger.warn(`Worker #${workerIndex} for ${task.data.threadUrl} stopped with exit code ${code}`);
                task.reject(new Error(`Worker stopped unexpectedly with exit code ${code}`));
            }
            
            // Free up the worker slot
            this.workers[workerIndex] = null;
            
            // A worker has finished, so we must re-run the main loop
            // to check if there are more tasks waiting in the queue.
            this.processQueue();
        });
    }
}

module.exports = WorkerPool;
