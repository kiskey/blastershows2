// src/utils/tmdb.js

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const TMDB_API_BASE = 'https://api.themoviedb.org/3';

async function searchTv(title, year) {
    if (!config.TMDB_API_KEY) {
        logger.warn('TMDB_API_KEY is not set. Skipping metadata search.');
        return null;
    }

    const searchParams = new URLSearchParams({
        api_key: config.TMDB_API_KEY,
        query: title,
    });

    // First, try a more specific search with the year
    if (year) {
        searchParams.append('first_air_date_year', year);
        const urlWithYear = `${TMDB_API_BASE}/search/tv?${searchParams.toString()}`;
        try {
            const { data } = await axios.get(urlWithYear, { timeout: 5000 });
            if (data.results && data.results.length > 0) {
                logger.info({ title, year }, 'Found TMDb match with year.');
                return data.results[0]; // Return the top result
            }
        } catch (e) {
            logger.warn({ err: e.message }, 'TMDb search with year failed.');
        }
    }
    
    // If search with year fails or returns no results, try without the year
    searchParams.delete('first_air_date_year');
    const urlWithoutYear = `${TMDB_API_BASE}/search/tv?${searchParams.toString()}`;
    try {
        const { data } = await axios.get(urlWithoutYear, { timeout: 5000 });
        if (data.results && data.results.length > 0) {
            logger.info({ title }, 'Found TMDb match without year.');
            return data.results[0]; // Return the top result
        }
    } catch (e) {
        logger.error({ err: e.message }, 'TMDb search without year failed.');
    }

    logger.warn({ title, year }, 'No TMDb match found.');
    return null;
}

module.exports = { searchTv };
