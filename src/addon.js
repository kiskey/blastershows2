// src/addon.js

const express = require('express');
const cors = require('cors');
const dataManager = require('./database/dataManager');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redis = require('./database/redis');

const app = express();
app.use(cors());
app.use((req, res, next) => {
    logger.info({ path: req.path, query: req.query }, 'Request received');
    next();
});

const MANIFEST = {
    id: 'tamilblasters.series.provider.final',
    version: '2.4.0', // Final version for this robust architecture
    name: 'TamilBlasters Provider',
    description: 'Provides P2P streams from the 1TamilBlasters forum for TV Series.',
    types: ['series'],
    resources: ['stream'],
    catalogs: [
        {
            type: 'series',
            id: 'tamilblasters-series-search',
            name: 'TamilBlasters Search',
            extra: [{ name: 'search', isRequired: true }]
        }
    ],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

app.get('/stream/series/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Stream request for id: ${id}`);
    
    const idParts = id.split(':');
    const sourceId = idParts[0];

    let tmdbId = null;

    if (sourceId.startsWith('tt')) {
        // It's an IMDb ID. Look it up in OUR Redis database for speed and accuracy.
        logger.info({ imdbId: sourceId }, 'IMDb ID detected, looking up in local Redis map...');
        tmdbId = await dataManager.getTmdbIdByImdbId(sourceId);
    } else if (sourceId === 'tmdb') {
        // It's already a TMDb ID.
        tmdbId = idParts[1];
    }

    if (!tmdbId) {
        logger.warn({ id }, 'Could not resolve a TMDb ID from request, returning no streams.');
        return res.json({ streams: [] });
    }

    const streams = await dataManager.getStreamsByTmdbId(tmdbId);
    if (!streams || streams.length === 0) {
        logger.warn({ tmdbId }, 'No streams found in our database for this TMDb ID.');
        return res.json({ streams: [] });
    }

    logger.info({ tmdbId, count: streams.length }, 'Returning streams.');
    res.json({ streams });
});

app.get('/catalog/series/tamilblasters-series-search.json', (req, res) => {
    logger.info('Responding to dummy search catalog request.');
    res.json({ metas: [] });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/debug/redis/:key', async (req, res) => {
    if (config.NODE_ENV !== 'development') {
        return res.status(403).send('Forbidden in production environment');
    }
    const { key } = req.params;
    logger.info({ key }, 'Redis debug request');
    
    try {
        const type = await redis.type(key);
        let data;

        switch (type) {
            case 'hash':
                data = await redis.hgetall(key);
                break;
            case 'string':
                data = await redis.get(key);
                break;
            case 'none':
                return res.status(404).json({ error: 'Key not found' });
            default:
                return res.status(400).json({ error: `Unsupported key type: ${type}` });
        }
        
        if (type === 'hash') {
            for (const field in data) {
                try {
                    data[field] = JSON.parse(data[field]);
                } catch (e) { /* Not JSON, leave as is */ }
            }
        }
        
        res.json({ key, type, data });

    } catch (error) {
        logger.error({ err: error, key }, 'Error during redis debug');
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

function startServer() {
    const port = config.PORT;
    app.listen(port, () => {
        logger.info(`Stremio addon server listening on http://localhost:${port}`);
    });
}

module.exports = { startServer };
