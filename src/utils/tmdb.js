// src/utils/tmdb.js

const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const TMDB_API_BASE = 'https://api.themoviedb.org/3';

async function searchTv(title, year) {
    // ... this function remains exactly the same ...
    if (!config.TMDB_API_KEY) { return null; }
    const searchParams = new URLSearchParams({ api_key: config.TMDB_API_KEY, query: title });
    if (year) {
        searchParams.append('first_air_date_year', year);
        try {
            const { data } = await axios.get(`${TMDB_API_BASE}/search/tv?${searchParams.toString()}`, { timeout: 5000 });
            if (data.results && data.results.length > 0) return data.results[0];
        } catch (e) { /* continue */ }
    }
    searchParams.delete('first_air_date_year');
    try {
        const { data } = await axios.get(`${TMDB_API_BASE}/search/tv?${searchParams.toString()}`, { timeout: 5000 });
        if (data.results && data.results.length > 0) return data.results[0];
    } catch (e) {
        logger.error({ err: e.message }, 'TMDb search failed.');
    }
    return null;
}

// --- START OF NEW FUNCTION ---
/**
 * Fetches the full details of a TV show from TMDb, including its external IDs.
 * @param {number} tmdbId - The TMDb ID of the show.
 * @returns {Promise<object|null>} The full TV details object or null.
 */
async function getTvDetails(tmdbId) {
    if (!config.TMDB_API_KEY) return null;

    const detailsUrl = `${TMDB_API_BASE}/tv/${tmdbId}?api_key=${config.TMDB_API_KEY}&append_to_response=external_ids`;

    try {
        const { data } = await axios.get(detailsUrl, { timeout: 5000 });
        // The IMDb ID is in the external_ids part of the response
        const imdbId = data.external_ids ? data.external_ids.imdb_id : null;
        if (imdbId) {
            logger.info({ tmdbId, imdbId }, 'Fetched TV details and found IMDb ID.');
            return { tmdbId, imdbId };
        }
    } catch (e) {
        logger.error({ err: e.message, tmdbId }, 'Failed to get TV details from TMDb.');
    }
    return null;
}
// --- END OF NEW FUNCTION ---

// We no longer need findByImdbId, so it is removed.
module.exports = { searchTv, getTvDetails };
