// src/crawler/workerPool.js

const { Worker } = require('worker_threads');
const logger = require('../utils/logger');
const { EventEmitter } = require('events');

class WorkerPool extends EventEmitter {
    constructor(numThreads, workerPath) {
        super();
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.taskQueue = [];
        this.workers = [];
        this.activeTasks = 0;
        this.onFinished = null;

        for (let i = 0; i < this.numThreads; i++) {
            this.createWorker(i);
        }
    }

    createWorker(index) {
        const worker = new Worker(this.workerPath);
        
        worker.on('message', (message) => {
            if (message === 'ready') {
                // The worker is ready for a new task.
                this.dispatchTask(worker);
            } else if (message === 'done') {
                // The worker has completed a task.
                this.activeTasks--;
                if (this.activeTasks === 0 && this.taskQueue.length === 0) {
                    if (this.onFinished) {
                        this.onFinished();
                        this.onFinished = null;
                    }
                }
                // Now that it's done, it's ready for another task.
                this.dispatchTask(worker);
            }
        });

        worker.on('error', (err) => {
            logger.error({ err }, `Worker #${index} encountered a critical error. Recreating worker.`);
            // A worker crashed, recreate it to maintain pool size.
            worker.terminate();
            this.createWorker(index);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn(`Worker #${index} exited with code ${code}. Recreating.`);
                this.createWorker(index);
            }
        });
        
        this.workers[index] = worker;
    }

    dispatchTask(worker) {
        if (this.taskQueue.length > 0) {
            const task = this.taskQueue.shift();
            worker.postMessage(task);
        }
    }

    run(taskData) {
        this.taskQueue.push(taskData);
        this.activeTasks++;
        // Find an idle worker to start processing immediately
        this.workers.forEach(worker => {
            // A truly idle worker would have no active task and would have messaged 'ready'.
            // A simpler approach is to just try to dispatch to all, the worker logic will handle it.
            // This is a bit brute-force but effective.
            this.dispatchTask(worker);

        });
    }

    wait() {
        return new Promise(resolve => {
            if (this.activeTasks === 0 && this.taskQueue.length === 0) {
                return resolve();
            }
            this.onFinished = resolve;
        });
    }
}

module.exports = WorkerPool;
