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
    id: 'tamilblasters.webseries.addon',
    version: '1.0.1', // Incremented version
    name: 'TamilBlasters Web Series',
    description: 'Provides Web Series and TV Shows from the 1TamilBlasters forum. This is a custom solution where all content is treated as movies.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'tamil-web-series',
            name: 'TamilBlasters Series',
        },
    ],
    idPrefixes: ['tbs-'],
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

app.get('/catalog/movie/:catalogId.json', async (req, res) => {
    logger.info(`Catalog request for id: ${req.params.catalogId}`);
    if (req.params.catalogId !== 'tamil-web-series') {
        return res.status(404).send('Not Found');
    }
    const metas = await dataManager.getCatalog();
    res.json({ metas });
});

app.get('/meta/movie/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Meta request for id: ${id}`);
    const meta = await dataManager.getMeta(id);
    if (!meta) {
        return res.status(404).send('Not Found');
    }
    res.json({ meta });
});

app.get('/stream/movie/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Stream request for id: ${id}`);
    const streams = await dataManager.getStreams(id);
    if (!streams || streams.length === 0) {
        return res.status(404).send('Not Found');
    }
    res.json({ streams });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ---- START OF NEW DEBUG ENDPOINT ----
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
// ---- END OF NEW DEBUG ENDPOINT ----

function startServer() {
    const port = config.PORT;
    app.listen(port, () => {
        logger.info(`Stremio addon server listening on http://localhost:${port}`);
    });
}

module.exports = { startServer };
