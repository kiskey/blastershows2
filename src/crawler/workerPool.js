// src/crawler/workerPool.js

const { Worker } = require('worker_threads');
const logger = require('../utils/logger');
const { EventEmitter } = require('events');

// A high-water mark for the queue. If the queue size exceeds this, the crawler will wait.
// 2 * numThreads is a safe default, meaning we buffer a few tasks per worker.
const MAX_QUEUE_SIZE = 200; 

class WorkerPool extends EventEmitter {
    constructor(numThreads, workerPath) {
        super();
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.workers = new Array(numThreads).fill(null);
        this.taskQueue = [];
        this.activeTasks = 0;
        this.isDrained = true;
    }

    /**
     * Adds a task to the queue. Returns a Promise that resolves when the task
     * has been successfully added. It will wait if the queue is full.
     * @param {object} taskData - The data for the worker.
     */
    async run(taskData) {
        // If the queue is full, wait for the 'ready' event.
        while (this.taskQueue.length >= MAX_QUEUE_SIZE) {
            await new Promise(resolve => this.once('ready', resolve));
        }
        
        this.taskQueue.push(taskData);
        this.isDrained = false;
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

            // Signal that the queue has a free slot.
            this.emit('ready');

            this.activeTasks++;
            this.startWorker(idleWorkerIndex, taskData);
        }
    }

    startWorker(workerIndex, taskData) {
        const worker = new Worker(this.workerPath, { workerData: taskData });
        this.workers[workerIndex] = worker;

        logger.info(`Starting worker #${workerIndex} for thread: ${taskData.threadUrl}`);

        const onDone = () => {
            if (this.workers[workerIndex] !== null) {
                this.workers[workerIndex] = null;
                this.activeTasks--;
                
                // A worker is free, check for more tasks
                this.processQueue();

                // If all work is done, emit the drained event
                if (this.activeTasks === 0 && this.taskQueue.length === 0) {
                    this.isDrained = true;
                    this.emit('drained');
                }
            }
        };

        worker.on('message', (result) => {
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
            onDone();
        });
    }

    onDrained() {
        return new Promise(resolve => {
            if (this.isDrained) {
                resolve();
            } else {
                this.once('drained', resolve);
            }
        });
    }
}

module.exports = WorkerPool;
