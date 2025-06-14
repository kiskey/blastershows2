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
    id: 'tamilblasters.series.provider',
    version: '2.0.1', // Incremented version for the fix
    name: 'TamilBlasters Provider',
    description: 'Provides P2P streams from the 1TamilBlasters forum for TV Series.',
    resources: ['stream'],
    types: ['series'], 
    idPrefixes: ['tmdb:'], // We can simplify this to just what we handle
    catalogs: [],

    // --- START OF THE FIX ---
    // This hints to Stremio that this addon can provide content for items
    // viewed elsewhere in the app, effectively activating it as a provider.
    "behaviorHints": {
        "configurable": true,
        "configurationRequired": false
    }
    // --- END OF THE FIX ---
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

app.get('/stream/series/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Stream request for id: ${id}`);
    
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
