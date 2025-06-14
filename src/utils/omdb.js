// src/utils/omdb.js

const apiClient = require('./apiClient');
const config = require('./config');
const logger = require('./logger');

const OMDB_API_BASE = `http://www.omdbapi.com/`;

/**
 * Searches OMDb for a series by title.
 * @param {string} title - The title to search for.
 * @returns {Promise<object|null>} The OMDb result, containing an IMDb ID.
 */
async function searchOmdb(title) {
    if (!config.OMDB_API_KEY) {
        logger.warn('OMDB_API_KEY is not set. Skipping OMDb search.');
        return null;
    }

    const searchParams = new URLSearchParams({
        apikey: config.OMDB_API_KEY,
        t: title,
        type: 'series',
    });

    try {
        const { data } = await apiClient.get(`${OMDB_API_BASE}?${searchParams.toString()}`, { timeout: 7000 });
        if (data && data.Response === 'True' && data.imdbID) {
            logger.info({ title, imdbId: data.imdbID }, 'Found OMDb match.');
            // Return a standardized object
            return {
                imdbId: data.imdbID,
                title: data.Title,
                year: data.Year.match(/\d{4}/)?.[0] || null,
                poster: data.Poster !== 'N/A' ? data.Poster : null,
            };
        }
    } catch (e) {
        logger.warn({ err: e.message, title }, 'OMDb search failed.');
    }

    return null;
}

module.exports = { searchOmdb };
