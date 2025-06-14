require('dotenv').config();

const config = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: parseInt(process.env.PORT, 10) || 7000,
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    FORUM_URL: process.env.FORUM_URL || 'https://www.1tamilblasters.fi/index.php?/forums/forum/63-tamil-new-web-series-tv-shows/',
    DOMAIN_MONITOR: process.env.DOMAIN_MONITOR || 'http://1tamilblasters.net',
    PURGE_ON_START: process.env.PURGE_ON_START === 'true',
    PURGE_ORPHANS_ON_START: process.env.PURGE_ORPHANS_ON_START === 'true',
    INITIAL_PAGES: parseInt(process.env.INITIAL_PAGES, 10) || 2,
    CRAWL_INTERVAL: parseInt(process.env.CRAWL_INTERVAL, 10) || 1800,
    THREAD_REVISIT_HOURS: parseInt(process.env.THREAD_REVISIT_HOURS, 10) || 24,
    MAX_CONCURRENCY: parseInt(process.env.MAX_CONCURRENCY, 10) || 4,
    USER_AGENT: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    TMDB_API_KEY: process.env.TMDB_API_KEY || null,
    OMDB_API_KEY: process.env.OMDB_API_KEY || null,
};

// Validate URLs
try {
    new URL(config.FORUM_URL);
    new URL(config.DOMAIN_MONITOR);
} catch (e) {
    console.error('Invalid URL in environment variables:', e.message);
    process.exit(1);
}

module.exports = config;
