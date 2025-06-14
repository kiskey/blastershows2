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
    id: 'tamilblasters.series.hybrid',
    version: '3.2.0', // Version bump for orphan logging feature
    name: 'TamilBlasters Hybrid',
    description: 'Provides a custom catalog and intelligently filtered P2P streams for TV Series from the 1TamilBlasters forum.',
    types: ['series'],
    resources: ['catalog', 'stream'],
    catalogs: [
        {
            type: 'series',
            id: 'tamilblasters-custom',
            name: 'TamilBlasters Catalog'
        }
    ],
    idPrefixes: ['tt', 'tmdb'],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

app.get('/catalog/series/tamilblasters-custom.json', async (req, res) => {
    logger.info('Request for custom catalog received.');
    const metas = await dataManager.getCustomCatalog();
    res.json({ metas });
});

app.get('/stream/series/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Stream request for id: ${id}`);
    
    const idParts = id.split(':');
    const sourceId = idParts[0];
    const requestedSeason = idParts[1] ? parseInt(idParts[1], 10) : null;
    const requestedEpisode = idParts[2] ? parseInt(idParts[2], 10) : null;
    
    let tmdbId = null;
    if (sourceId.startsWith('tt')) {
        tmdbId = await dataManager.getTmdbIdByImdbId(sourceId);
    } else if (sourceId === 'tmdb') {
        tmdbId = idParts[1];
    }

    if (!tmdbId) {
        logger.warn({ id }, 'Could not resolve a TMDb ID from request, returning no streams.');
        return res.json({ streams: [] });
    }

    const streams = await dataManager.getStreamsByTmdbId(tmdbId, requestedSeason, requestedEpisode);
    
    if (!streams || streams.length === 0) {
        logger.warn({ tmdbId, requestedSeason, requestedEpisode }, 'No matching streams found in our database.');
        return res.json({ streams: [] });
    }

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
            case 'zset':
                 data = await redis.zrevrange(key, 0, -1, 'WITHSCORES');
                 break;
            case 'list': // Support for the new orphan list
                 data = await redis.lrange(key, 0, -1);
                 break;
            case 'none':
                return res.status(404).json({ error: 'Key not found' });
            default:
                return res.status(400).json({ error: `Unsupported key type: ${type}` });
        }
        
        // Universal JSON parsing for list or hash values
        const parseJson = (item) => {
            try { return JSON.parse(item); } catch (e) { return item; }
        };

        if (type === 'hash') {
            for (const field in data) { data[field] = parseJson(data[field]); }
        } else if (type === 'list' || type === 'zset') {
            data = data.map(parseJson);
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
