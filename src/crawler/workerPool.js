// src/crawler/workerPool.js

const { Worker } = require('worker_threads');
const logger = require('../utils/logger');
const { EventEmitter } = require('events');

class WorkerPool extends EventEmitter {
    constructor(numThreads, workerPath) {
        super();
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.workers = new Array(numThreads).fill(null);
        this.taskQueue = [];
        this.activeTasks = 0;

        // Listen for internal event when a task is done
        this.on('task_done', () => {
            this.activeTasks--;
            // If all queues and active workers are done, emit a 'drained' event
            if (this.activeTasks === 0 && this.taskQueue.length === 0) {
                this.emit('drained');
            }
        });
    }

    /**
     * Adds a task to the queue and immediately tries to process it.
     * This is now a "fire-and-forget" method.
     * @param {object} taskData - The data for the worker.
     */
    run(taskData) {
        this.taskQueue.push(taskData);
        this.processQueue();
    }

    processQueue() {
        while (this.taskQueue.length > 0) {
            const idleWorkerIndex = this.workers.findIndex(w => w === null);
            if (idleWorkerIndex === -1) {
                break; // All workers are busy
            }

            const taskData = this.taskQueue.shift();
            if (!taskData) continue;

            this.activeTasks++;
            this.startWorker(idleWorkerIndex, taskData);
        }
    }

    startWorker(workerIndex, taskData) {
        const worker = new Worker(this.workerPath, { workerData: taskData });
        this.workers[workerIndex] = worker;

        logger.info(`Starting worker #${workerIndex} for thread: ${taskData.threadUrl}`);

        const onDone = () => {
            // This ensures we only handle completion once
            if (this.workers[workerIndex] !== null) {
                this.workers[workerIndex] = null;
                this.emit('task_done');
                this.processQueue(); // A worker is free, check for more tasks
            }
        };

        worker.on('message', (result) => {
            logger.info(`Worker #${workerIndex} finished task for ${taskData.threadUrl} with status: ${result.status}`);
            onDone();
        });

        worker.on('error', (error) => {
            logger.error({ err: error, url: taskData.threadUrl }, `Worker #${workerIndex} encountered an error`);
            onDone();
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn(`Worker #${workerIndex} for ${taskData.threadUrl} stopped with exit code ${code}`);
            }
            // The 'message' or 'error' event should have already called onDone,
            // but this is a safeguard to ensure the slot is always freed.
            onDone();
        });
    }

    /**
     * Returns a promise that resolves when all tasks in the queue have been processed.
     */
    onDrained() {
        return new Promise(resolve => {
            if (this.activeTasks === 0 && this.taskQueue.length === 0) {
                resolve();
            } else {
                this.once('drained', resolve);
            }
        });
    }
}

module.exports = WorkerPool;
