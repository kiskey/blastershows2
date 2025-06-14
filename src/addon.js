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

// --- START OF THE DEFINITIVE FIX ---
const MANIFEST = {
    id: 'tamilblasters.series.provider',
    version: '2.1.0', // New version for the manifest fix
    name: 'TamilBlasters Provider',
    description: 'Provides P2P streams from the 1TamilBlasters forum for TV Series.',
    
    // We only support the 'series' type.
    types: ['series'],
    
    // We no longer provide a catalog.
    catalogs: [],

    // This is the crucial change. We define "stream" as an object.
    resources: [
        {
            name: "stream",
            types: ["series"],
            idPrefixes: ["tmdb"] // We can provide streams for items with a "tmdb" prefix.
        }
    ],
    
    // behaviorHints can be simplified. The presence of infoHash already implies P2P.
    // The most important thing was the structured 'resources' array.
    behaviorHints: {
        configurable: false, // We can set this to false as there's no configuration page.
        configurationRequired: false
    }
};
// --- END OF THE DEFINITIVE FIX ---

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

app.get('/stream/series/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Stream request for id: ${id}`);
    
    // The ID will be in the format "tmdb:12345". We need to remove the prefix for our lookup.
    const tmdbId = id.replace('tmdb:', '');
    if (!tmdbId) {
        logger.warn({ id }, 'Request with invalid ID format, returning no streams.');
        return res.json({ streams: [] });
    }

    const streams = await dataManager.getStreamsByTmdbId(tmdbId);
    if (!streams || streams.length === 0) {
        logger.warn({ tmdbId }, 'No streams found for this TMDb ID.');
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
