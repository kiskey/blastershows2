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
    id: 'tamilblasters.webseries.addon',
    version: '1.0.0',
    name: 'TamilBlasters Web Series',
    description: 'Provides Web Series and TV Shows from the 1TamilBlasters forum. This is a custom solution where all content is treated as movies.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'], // As per requirement, we use 'movie' type
    catalogs: [
        {
            type: 'movie',
            id: 'tamil-web-series',
            name: 'TamilBlasters Series',
        },
    ],
    idPrefixes: ['tbs-'], // Custom ID prefix
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

function startServer() {
    const port = config.PORT;
    app.listen(port, () => {
        logger.info(`Stremio addon server listening on http://localhost:${port}`);
    });
}

module.exports = { startServer };
