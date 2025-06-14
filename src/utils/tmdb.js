// src/utils/tmdb.js

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const TMDB_API_BASE = 'https://api.themoviedb.org/3';

// ... searchTv function remains exactly the same ...
async function searchTv(title, year) {
    if (!config.TMDB_API_KEY) {
        logger.warn('TMDB_API_KEY is not set. Skipping metadata search.');
        return null;
    }
    const searchParams = new URLSearchParams({ api_key: config.TMDB_API_KEY, query: title });
    if (year) {
        searchParams.append('first_air_date_year', year);
        const urlWithYear = `${TMDB_API_BASE}/search/tv?${searchParams.toString()}`;
        try {
            const { data } = await axios.get(urlWithYear, { timeout: 5000 });
            if (data.results && data.results.length > 0) {
                logger.info({ title, year }, 'Found TMDb match with year.');
                return data.results[0];
            }
        } catch (e) {
            logger.warn({ err: e.message }, 'TMDb search with year failed.');
        }
    }
    searchParams.delete('first_air_date_year');
    const urlWithoutYear = `${TMDB_API_BASE}/search/tv?${searchParams.toString()}`;
    try {
        const { data } = await axios.get(urlWithoutYear, { timeout: 5000 });
        if (data.results && data.results.length > 0) {
            logger.info({ title }, 'Found TMDb match without year.');
            return data.results[0];
        }
    } catch (e) {
        logger.error({ err: e.message }, 'TMDb search without year failed.');
    }
    logger.warn({ title, year }, 'No TMDb match found.');
    return null;
}


// --- START OF NEW FUNCTION ---
/**
 * Finds a TMDb ID by using an external ID (like an IMDb ID).
 * @param {string} imdbId - The IMDb ID (e.g., "tt10919420").
 * @returns {Promise<number|null>} The TMDb ID or null if not found.
 */
async function findByImdbId(imdbId) {
    if (!config.TMDB_API_KEY) {
        logger.warn('TMDB_API_KEY is not set. Skipping external ID search.');
        return null;
    }

    const findUrl = `${TMDB_API_BASE}/find/${imdbId}?api_key=${config.TMDB_API_KEY}&external_source=imdb_id`;

    try {
        const { data } = await axios.get(findUrl, { timeout: 5000 });
        // The find endpoint returns results for movies, tv, etc. We need the tv_results.
        if (data.tv_results && data.tv_results.length > 0) {
            const tmdbId = data.tv_results[0].id;
            logger.info({ imdbId, tmdbId }, 'Successfully converted IMDb ID to TMDb ID.');
            return tmdbId;
        }
    } catch (e) {
        logger.error({ err: e.message, imdbId }, 'Failed to find TMDb ID by IMDb ID.');
    }

    logger.warn({ imdbId }, 'Could not find a matching TMDb ID for the given IMDb ID.');
    return null;
}
// --- END OF NEW FUNCTION ---

module.exports = { searchTv, findByImdbId };
