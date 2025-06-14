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
    if (req.path !== '/') {
        logger.info({ path: req.path, query: req.query }, 'Request received');
    }
    next();
});

const MANIFEST = {
    id: 'tamilblasters.series.hybrid',
    version: '3.3.0',
    name: 'TamilBlasters Hybrid',
    description: 'Provides a custom catalog and intelligently filtered P2P streams for TV Series from the 1TamilBlasters forum.',
    types: ['series'],
    resources: ['catalog', 'stream'],
    catalogs: [{ type: 'series', id: 'tamilblasters-custom', name: 'TamilBlasters Catalog' }],
    idPrefixes: ['tt', 'tmdb'],
    behaviorHints: { configurable: false, configurationRequired: false }
};

app.get('/', (req, res) => {
    const manifestUrl = `${req.protocol}://${req.get('host')}/manifest.json`;
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${MANIFEST.name} Status</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; background-color: #f4f6f8; color: #1a202c; }
            .container { max-width: 800px; margin: 40px auto; padding: 20px; background: white; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            h1, h2 { color: #2d3748; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; }
            h1 { text-align: center; }
            p { line-height: 1.6; }
            a { color: #3182ce; text-decoration: none; }
            a:hover { text-decoration: underline; }
            code { background-color: #edf2f7; padding: 2px 6px; border-radius: 4px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace; }
            pre { background-color: #1a202c; color: #e2e8f0; padding: 15px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; }
            .install-button { display: inline-block; padding: 10px 20px; background-color: #48bb78; color: white; text-align: center; border-radius: 5px; font-weight: bold; margin-top: 10px; }
            .section { margin-bottom: 30px; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e2e8f0; }
            th { background-color: #f7fafc; }
            td:first-child { font-weight: bold; color: #4a5568; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>${MANIFEST.name} v${MANIFEST.version}</h1>
            <p style="text-align:center;">${MANIFEST.description}</p>
            <div style="text-align:center;">
                <a href="stremio://install-addon/${encodeURIComponent(manifestUrl)}" class="install-button">Install Addon</a>
            </div>
            <div class="section">
                <h2>Endpoints & Usage</h2>
                <table>
                    <tr><th>Endpoint</th><th>Description & Example</th></tr>
                    <tr><td><code>/manifest.json</code></td><td>The addon's manifest file.</td></tr>
                    <tr><td><code>/catalog/series/tamilblasters-custom.json</code></td><td>Serves the custom, browseable catalog.</td></tr>
                    <tr><td><code>/stream/series/{id}.json</code></td><td>Provides streams. Example ID: <code>tt1234567:1:1</code></td></tr>
                    <tr><td><code>/debug/redis/{key}</code></td><td>Inspect a Redis key. <br><b>Example (IMDb Map):</b> <code>/debug/redis/imdb_map%3Att10919420</code><br><b>Example (Orphans):</b> <code>/debug/redis/unmatched_magnets?page=1</code></td></tr>
                </table>
            </div>
            <div class="section"><h2>Configuration</h2><pre><code>${JSON.stringify(config, null, 2)}</code></pre></div>
            <div class="section"><h2>Manifest Details</h2><pre><code>${JSON.stringify(MANIFEST, null, 2)}</code></pre></div>
        </div>
    </body>
    </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

app.get('/manifest.json', (req, res) => { res.json(MANIFEST); });
app.get('/catalog/series/tamilblasters-custom.json', async (req, res) => {
    logger.info('Request for custom catalog received.');
    const metas = await dataManager.getCustomCatalog();
    res.json({ metas });
});
app.get('/stream/series/:id.json', async (req, res) => {
    const { id } = req.params;
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
    if (!tmdbId) return res.json({ streams: [] });
    const streams = await dataManager.getStreamsByTmdbId(tmdbId, requestedSeason, requestedEpisode);
    if (!streams || streams.length === 0) return res.json({ streams: [] });
    res.json({ streams });
});
app.get('/health', (req, res) => { res.status(200).send('OK'); });

// --- DEBUG ENDPOINT WITH PAGINATION ---
app.get('/debug/redis/:key', async (req, res) => {
    if (config.NODE_ENV !== 'development') {
        return res.status(403).send('Forbidden in production environment');
    }
    const { key } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 100;
    const start = (page - 1) * limit;
    const end = start + limit - 1;

    logger.info({ key, page }, 'Redis debug request');
    
    try {
        const type = await redis.type(key);
        let data, totalItems = 0;

        switch (type) {
            case 'hash': data = await redis.hgetall(key); break;
            case 'string': data = await redis.get(key); break;
            case 'zset': data = await redis.zrevrange(key, 0, -1, 'WITHSCORES'); break;
            case 'list':
                 totalItems = await redis.llen(key);
                 data = await redis.lrange(key, start, end);
                 break;
            case 'none': return res.status(404).json({ error: 'Key not found' });
            default: return res.status(400).json({ error: `Unsupported key type: ${type}` });
        }
        
        const parseJson = (item) => { try { return JSON.parse(item); } catch (e) { return item; } };
        if (type === 'hash') { for (const field in data) data[field] = parseJson(data[field]); }
        else if (type === 'list' || type === 'zset') { data = data.map(parseJson); }
        
        if (type === 'list') {
            res.json({
                key, type, pagination: {
                    currentPage: page, pageSize: limit, totalItems,
                    totalPages: Math.ceil(totalItems / limit)
                }, data
            });
        } else {
             res.json({ key, type, data });
        }
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
