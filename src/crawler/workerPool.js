// src/crawler/workerPool.js

const { Worker } = require('worker_threads');
const logger = require('../utils/logger');
const { EventEmitter } = require('events');

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

    async run(taskData) {
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
                break;
            }

            const taskData = this.taskQueue.shift();
            if (!taskData) continue;

            this.emit('ready');
            this.activeTasks++;
            this.startWorker(idleWorkerIndex, taskData);
        }
    }

    startWorker(workerIndex, taskData) {
        // This is now the simple, correct way to create a worker.
        // It will inherit the --expose-gc flag from the main process.
        const worker = new Worker(this.workerPath, { 
            workerData: taskData
        });
        
        this.workers[workerIndex] = worker;

        logger.info(`Starting worker #${workerIndex} for thread: ${taskData.threadUrl}`);

        const onDone = () => {
            if (this.workers[workerIndex] !== null) {
                this.workers[workerIndex] = null;
                this.activeTasks--;
                
                this.processQueue();

                if (this.activeTasks === 0 && this.taskQueue.length === 0) {
                    this.isDrained = true;
                    this.emit('drained');
                }
            }
        };

        worker.on('message', () => {
            // Let 'exit' handle the onDone call to ensure it's always called.
        });

        worker.on('error', (error) => {
            logger.error({ err: error, url: taskData.threadUrl }, `Worker #${workerIndex} encountered an error`);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn(`Worker #${workerIndex} for ${taskData.threadUrl} stopped with exit code ${code}`);
            }
            // onDone() is the single point of cleanup and continuation.
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
