// src/addon.js

const express = require('express');
const cors = require('cors');
const dataManager = require('./database/dataManager');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redis = require('./database/redis'); // Import redis client for debug

const app = express();
app.use(cors());
app.use((req, res, next) => {
    logger.info({ path: req.path, query: req.query }, 'Request received');
    next();
});

const MANIFEST = {
    id: 'tamilblasters.series.provider',
    version: '2.0.0', // Major version change reflects new architecture
    name: 'TamilBlasters Provider',
    description: 'Provides P2P streams from the 1TamilBlasters forum for TV Series.',
    // We only provide streams for the existing 'series' type.
    resources: ['stream'],
    types: ['series'], 
    // This tells Stremio that we can provide streams for items with these ID prefixes.
    idPrefixes: ['tmdb:', 'imdb:'],
    catalogs: [] // We no longer provide our own catalog.
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

// This is now our one and only primary content endpoint.
app.get('/stream/series/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Stream request for id: ${id}`);
    
    // The ID will be in the format "tmdb:12345" or "imdb:tt12345".
    // We will primarily handle TMDb IDs.
    const [source, externalId] = id.split(':');
    if (source !== 'tmdb' || !externalId) {
        logger.warn({ id }, 'Request for non-TMDb ID or invalid format, returning no streams.');
        return res.json({ streams: [] });
    }

    const streams = await dataManager.getStreamsByTmdbId(externalId);
    if (!streams || streams.length === 0) {
        logger.warn({ tmdbId: externalId }, 'No streams found for this TMDb ID.');
        return res.json({ streams: [] });
    }

    logger.info({ tmdbId: externalId, count: streams.length }, 'Returning streams.');
    res.json({ streams });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// The debug endpoint remains as it is very useful for checking data.
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
        
        // If data is a hash with JSON strings, parse them for readability
        if (type === 'hash') {
            for (const field in data) {
                try {
                    data[field] = JSON.parse(data[field]);
                } catch (e) {
                    // Not a JSON string, leave as is
                }
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
