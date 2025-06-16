// src/utils/tmdb.js

const apiClient = require('./apiClient');
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

async function getTvDetails(id) { // Accepts either tmdbId (number) or imdbId (string)
    if (!config.TMDB_API_KEY) return null;

    const isImdb = id.toString().startsWith('tt');
    const findUrl = `${TMDB_API_BASE}/${isImdb ? 'find' : 'tv'}/${id}?api_key=${config.TMDB_API_KEY}${isImdb ? '&external_source=imdb_id' : '&append_to_response=external_ids'}`;

    try {
        const { data } = await apiClient.get(findUrl, { timeout: 7000 });
        
        const results = isImdb ? data.tv_results : [data];
        
        if (results && results.length > 0) {
            const show = results[0];
            const imdbId = isImdb ? id : (show.external_ids ? show.external_ids.imdb_id : null);
            const tmdbId = show.id;

            if (imdbId && tmdbId) {
                logger.info({ tmdbId, imdbId }, 'Fetched TV details and confirmed ID pair.');
                return { tmdbId, imdbId, name: show.name, poster_path: show.poster_path, first_air_date: show.first_air_date };
            }
        }
    } catch (e) {
        logger.error({ err: e.message, id }, 'Final attempt to get TV details from TMDb failed.');
    }
    return null;
}

module.exports = { searchTv, getTvDetails };
