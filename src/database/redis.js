const Redis = require('ioredis');
const config = require('../utils/config');
const logger = require('../utils/logger');

const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true
});

client.on('connect', () => logger.info('Connected to Redis'));
client.on('ready', () => logger.info('Redis client is ready'));
client.on('error', (err) => logger.error({ err }, 'Redis client error'));

module.exports = client;
