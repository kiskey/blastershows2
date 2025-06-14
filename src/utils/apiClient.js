// src/utils/apiClient.js

const axios = require('axios');
const logger = require('./logger');

// Create a new axios instance with custom configuration
const apiClient = axios.create();

// Add a response interceptor to handle retries
apiClient.interceptors.response.use(
    (response) => response, // On success, just return the response
    async (error) => {
        const config = error.config;

        // Don't retry if it's already a retry, or if the error is not a network/server issue
        if (config.retryCount >= 2 || !error.response || error.response.status < 500) {
            return Promise.reject(error);
        }

        config.retryCount = (config.retryCount || 0) + 1;
        
        // Calculate delay with exponential backoff and some randomness (jitter)
        const backoff = Math.pow(2, config.retryCount) * 500; // 1s, 2s
        const delay = backoff + Math.random() * 500;
        
        logger.warn({
            url: config.url,
            retry: config.retryCount,
            delay: `${delay.toFixed(0)}ms`,
            status: error.response.status
        }, 'API request failed, retrying...');

        await new Promise(resolve => setTimeout(resolve, delay));

        // Retry the request
        return apiClient(config);
    }
);

module.exports = apiClient;
