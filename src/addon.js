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

// --- START OF THE DEFINITIVE MANIFEST FIX ---
const MANIFEST = {
    id: 'tamilblasters.series.provider.final',
    version: '2.2.0', // Final version for this fix
    name: 'TamilBlasters Provider',
    description: 'Provides P2P streams from the 1TamilBlasters forum for TV Series.',
    
    types: ['series'],
    
    // We declare that we provide the 'stream' resource.
    resources: ['stream'],

    // We no longer use idPrefixes at the top level.

    // This is the crucial part. We define a "dummy" catalog.
    // We don't intend for users to browse it, but it tells Stremio's system
    // that this addon supports the 'search' feature, which is how it
    // gets integrated into the main search and stream discovery.
    catalogs: [
        {
            type: 'series',
            id: 'tamilblasters-series-search',
            name: 'TamilBlasters Search',
            // By declaring 'search' as a supported 'extra', we signal
            // that this addon can be queried for any item.
            extra: [{ name: 'search', isRequired: true }]
        }
    ],
    
    // These hints are still good practice.
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};
// --- END OF THE DEFINITIVE MANIFEST FIX ---

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

// The stream handler logic is now correct.
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

// We must also add a handler for the dummy catalog, even if it does nothing.
// If Stremio ever calls it (e.g., during a search), we must respond.
app.get('/catalog/series/tamilblasters-series-search.json', (req, res) => {
    // We don't need to return any results here. The purpose of this catalog
    // is purely to register the addon as a provider.
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
