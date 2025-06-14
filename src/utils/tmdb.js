// src/utils/tmdb.js

const apiClient = require('./apiClient'); // Import our new resilient client
const config = require('./config');
const logger = require('./logger');

const TMDB_API_BASE = 'https://api.themoviedb.org/3';

async function searchTv(title, year) {
    if (!config.TMDB_API_KEY) {
        logger.warn('TMDB_API_KEY is not set. Skipping metadata search.');
        return null;
    }
    const searchParams = new URLSearchParams({ api_key: config.TMDB_API_KEY, query: title });
    if (year) {
        searchParams.append('first_air_date_year', year);
        try {
            const { data } = await apiClient.get(`${TMDB_API_BASE}/search/tv?${searchParams.toString()}`, { timeout: 7000 });
            if (data.results && data.results.length > 0) {
                logger.info({ title, year }, 'Found TMDb match with year.');
                return data.results[0];
            }
        } catch (e) {
            logger.warn({ err: e.message, title, year }, 'TMDb search with year failed.');
        }
    }
    searchParams.delete('first_air_date_year');
    try {
        const { data } = await apiClient.get(`${TMDB_API_BASE}/search/tv?${searchParams.toString()}`, { timeout: 7000 });
        if (data.results && data.results.length > 0) {
            logger.info({ title }, 'Found TMDb match without year.');
            return data.results[0];
        }
    } catch (e) {
        logger.error({ err: e.message, title }, 'Final TMDb search without year failed after retries.');
    }
    logger.warn({ title, year }, 'No TMDb match found.');
    return null;
}

async function getTvDetails(tmdbId) {
    if (!config.TMDB_API_KEY) return null;
    const detailsUrl = `${TMDB_API_BASE}/tv/${tmdbId}?api_key=${config.TMDB_API_KEY}&append_to_response=external_ids`;
    try {
        const { data } = await apiClient.get(detailsUrl, { timeout: 7000 });
        const imdbId = data.external_ids ? data.external_ids.imdb_id : null;
        if (imdbId) {
            logger.info({ tmdbId, imdbId }, 'Fetched TV details and found IMDb ID.');
            return { tmdbId, imdbId };
        } else {
             logger.warn({ tmdbId }, 'TV Details fetched but no IMDb ID was present.');
        }
    } catch (e) {
        logger.error({ err: e.message, tmdbId }, 'Final attempt to get TV details from TMDb failed.');
    }
    return null;
}

module.exports = { searchTv, getTvDetails };
