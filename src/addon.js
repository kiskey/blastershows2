// src/addon.js

const express = require('express');
const cors = require('cors');
const dataManager = require('./database/dataManager');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redis = require('./database/redis');
const { findByImdbId } = require('./utils/tmdb');

const app = express();
app.use(cors());
app.use((req, res, next) => {
    logger.info({ path: req.path, query: req.query }, 'Request received');
    next();
});

const MANIFEST = {
    id: 'tamilblasters.series.hybrid',
    version: '3.0.0', // Major version for new architecture
    name: 'TamilBlasters Hybrid',
    description: 'Provides a custom catalog and P2P streams for TV Series from the 1TamilBlasters forum.',
    types: ['series'],
    // We now provide our own catalog AND act as a stream provider for others.
    resources: ['catalog', 'stream'],
    
    catalogs: [
        {
            type: 'series',
            id: 'tamilblasters-custom',
            name: 'TamilBlasters Catalog'
        }
    ],
    
    // We explicitly state we can handle both ID prefixes.
    idPrefixes: ['tt', 'tmdb'],
    
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

// The new custom catalog endpoint
app.get('/catalog/series/tamilblasters-custom.json', async (req, res) => {
    logger.info('Request for custom catalog received.');
    const metas = await dataManager.getCustomCatalog();
    res.json({ metas });
});

// The universal stream handler remains the same
app.get('/stream/series/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Stream request for id: ${id}`);
    
    const idParts = id.split(':');
    const sourceId = idParts[0];

    let tmdbId = null;

    if (sourceId.startsWith('tt')) {
        logger.info({ imdbId: sourceId }, 'IMDb ID detected, looking up in local Redis map...');
        tmdbId = await dataManager.getTmdbIdByImdbId(sourceId);
    } else if (sourceId === 'tmdb') {
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
            case 'zset': // Added support for sorted sets
                 data = await redis.zrevrange(key, 0, -1, 'WITHSCORES');
                 break;
            case 'none':
                return res.status(404).json({ error: 'Key not found' });
            default:
                return res.status(400).json({ error: `Unsupported key type: ${type}` });
        }
        
        if (type === 'hash') {
            for (const field in data) {
                try { data[field] = JSON.parse(data[field]); } catch (e) {}
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
