// src/addon.js

const express = require('express');
const cors = require('cors');
const dataManager = require('./database/dataManager');
const config = require('./utils/config');
const logger = require('./utils/logger');
const redis = require('./database/redis');

const app = express();
app.use(cors());
// Don't log requests for the root path to keep logs clean
app.use((req, res, next) => {
    if (req.path !== '/') {
        logger.info({ path: req.path, query: req.query }, 'Request received');
    }
    next();
});

const MANIFEST = {
    id: 'tamilblasters.series.hybrid',
    version: '3.3.0', // Version bump for UI enhancement
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

// --- START OF NEW INDEX PAGE ROUTE ---
app.get('/', (req, res) => {
    const manifestUrl = `${req.protocol}://${req.get('host')}/manifest.json`;

    // A simple HTML template with embedded CSS for a clean look
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
                    <tr>
                        <td><code>/manifest.json</code></td>
                        <td>The addon's manifest file required by Stremio.</td>
                    </tr>
                    <tr>
                        <td><code>/catalog/series/tamilblasters-custom.json</code></td>
                        <td>Serves the custom, browseable catalog of all parsed shows.</td>
                    </tr>
                    <tr>
                        <td><code>/stream/series/{id}.json</code></td>
                        <td>Provides streams. Stremio calls this automatically. <br>Example ID: <code>tt1234567:1:1</code></td>
                    </tr>
                    <tr>
                        <td><code>/debug/redis/{key}</code></td>
                        <td>
                            Inspect a Redis key. Key must be URL encoded.
                            <br><b>Example (IMDb Map):</b> <code>/debug/redis/imdb_map%3Att10919420</code>
                            <br><b>Example (Streams):</b> <code>/debug/redis/stream%3Atmdb%3A122294</code>
                            <br><b>Example (Orphans):</b> <code>/debug/redis/unmatched_magnets</code>
                        </td>
                    </tr>
                </table>
            </div>

            <div class="section">
                <h2>Configuration</h2>
                <p>These are the current settings loaded from environment variables.</p>
                <pre><code>${JSON.stringify(config, null, 2)}</code></pre>
            </div>

            <div class="section">
                <h2>Manifest Details</h2>
                <pre><code>${JSON.stringify(MANIFEST, null, 2)}</code></pre>
            </div>
        </div>
    </body>
    </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});
// --- END OF NEW INDEX PAGE ROUTE ---

app.get('/manifest.json', (req, res) => {
    res.json(MANIFEST);
});

// ... all other endpoints (/catalog, /stream, /health, /debug) are unchanged ...
app.get('/catalog/series/tamilblasters-custom.json', async (req, res) => { /* ... */ });
app.get('/stream/series/:id.json', async (req, res) => { /* ... */ });
app.get('/health', (req, res) => { /* ... */ });
app.get('/debug/redis/:key', async (req, res) => { /* ... */ });


function startServer() {
    const port = config.PORT;
    app.listen(port, () => {
        logger.info(`Stremio addon server listening on http://localhost:${port}`);
    });
}

module.exports = { startServer };
