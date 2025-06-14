// src/addon.js

const express = require('express');
const cors = require('cors');
const dataManager = require('./database/dataManager');
const config = require('./utils/config');
const logger = require('./utils/logger');

const app = express();
app.use(cors());
app.use((req, res, next) => {
    logger.info({ path: req.path, query: req.query }, 'Request received');
    next();
});

const MANIFEST = {
    id: 'tamilblasters.series.provider',
    version: '2.0.0', // Major version change
    name: 'TamilBlasters Series Provider',
    description: 'Provides P2P streams from the 1TamilBlasters forum for TV Series.',
    // We only provide streams for the series type
    resources: ['stream'],
    types: ['series'], 
    // We want this addon to be installable for all series
    idPrefixes: ['tmdb:', 'imdb:'],
    catalogs: [] // We no longer provide a catalog
};

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

// This is now our one and only content endpoint
app.get('/stream/series/:id.json', async (req, res) => {
    const { id } = req.params;
    logger.info(`Stream request for id: ${id}`);
    
    // The ID will be in the format "tmdb:12345" or "imdb:tt12345"
    // We only handle tmdb for now.
    const [source, tmdbId] = id.split(':');
    if (source !== 'tmdb' || !tmdbId) {
        return res.json({ streams: [] });
    }

    const streams = await dataManager.getStreamsByTmdbId(tmdbId);
    if (!streams || streams.length === 0) {
        logger.warn({ tmdbId }, 'No streams found for this TMDb ID.');
        return res.json({ streams: [] });
    }

    res.json({ streams });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// The debug endpoint can remain as it's very useful
app.get('/debug/redis/:key', async (req, res) => {
    // ... (debug endpoint code remains the same)
});

function startServer() {
    const port = config.PORT;
    app.listen(port, () => {
        logger.info(`Stremio addon server listening on http://localhost:${port}`);
    });
}

module.exports = { startServer };
