// src/utils/trackers.js

const axios = require('axios');
const logger = require('./logger');

const TRACKER_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
let cachedTrackers = [];
let isFetching = false;

async function fetchAndCacheTrackers() {
    // Prevent multiple concurrent fetches
    if (isFetching) {
        logger.info('Tracker fetch already in progress.');
        return;
    }

    isFetching = true;
    logger.info('Fetching best trackers list...');
    
    try {
        const response = await axios.get(TRACKER_URL, { timeout: 10000 });
        const trackerList = response.data
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('udp://') || line.startsWith('http://') || line.startsWith('https://')); // Filter for valid trackers

        if (trackerList.length > 0) {
            cachedTrackers = trackerList;
            logger.info(`Successfully fetched and cached ${cachedTrackers.length} trackers.`);
        } else {
            logger.warn('Fetched tracker list was empty or invalid.');
        }
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to fetch trackers list. Will use previously cached version if available.');
    } finally {
        isFetching = false;
    }
}

function getTrackers() {
    return cachedTrackers;
}

// Fetch trackers on startup and then refresh every 6 hours
fetchAndCacheTrackers();
setInterval(fetchAndCacheTrackers, 6 * 60 * 60 * 1000); // 6 hours

module.exports = { getTrackers };
