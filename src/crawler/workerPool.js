// src/crawler/workerPool.js

const { Worker } = require('worker_threads');
const logger = require('../utils/logger');

class WorkerPool {
    constructor(numThreads, workerPath) {
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.taskQueue = [];
        this.workers = new Array(numThreads).fill(null);
        this.activeWorkers = 0;
        this.onFinished = null; // A callback to be called when all tasks are done
    }

    /**
     * Adds a task to the queue and starts processing if idle.
     * @param {object} taskData
     */
    run(taskData) {
        this.taskQueue.push(taskData);
        this.checkAndStartWorker();
    }

    /**
     * The core logic: if there's a waiting task and an idle worker, start it.
     */
    checkAndStartWorker() {
        if (this.taskQueue.length === 0) {
            // If the queue is empty and no workers are active, we are done.
            if (this.activeWorkers === 0 && this.onFinished) {
                this.onFinished();
                this.onFinished = null; // Prevent multiple calls
            }
            return;
        }

        const idleWorkerIndex = this.workers.findIndex(w => w === null);
        if (idleWorkerIndex === -1) {
            return; // All workers are busy
        }

        const task = this.taskQueue.shift();
        if (!task) return;

        this.activeWorkers++;
        const worker = new Worker(this.workerPath, { workerData: task });
        this.workers[idleWorkerIndex] = worker;

        logger.info(`Starting worker #${idleWorkerIndex} for thread: ${task.url}`);

        worker.on('exit', () => {
            // This is the only event we need to reliably track.
            this.workers[idleWorkerIndex] = null;
            this.activeWorkers--;
            
            // A worker has finished, immediately check if there's more work to do.
            this.checkAndStartWorker();
        });

        worker.on('error', (err) => {
            logger.error({ err, url: task.url }, `Worker #${idleWorkerIndex} had a critical error.`);
            // The 'exit' event will still fire, so cleanup happens there.
        });
    }

    /**
     * Returns a promise that resolves when all queued tasks are completed.
     */
    wait() {
        return new Promise(resolve => {
            if (this.taskQueue.length === 0 && this.activeWorkers === 0) {
                return resolve();
            }
            this.onFinished = resolve;
        });
    }
}

module.exports = WorkerPool;
