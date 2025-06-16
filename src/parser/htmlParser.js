// src/parser/htmlParser.js

const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const logger = require('../utils/logger');

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

function parseThreadPage(html, url) {
    try {
        const $ = cheerio.load(html);

        const title = $('span.ipsType_break.ipsContained').first().text().trim();
        if (!title) {
            logger.warn({ url }, 'Could not find title element on page.');
            return null;
        }

        let posterUrl = $('img.ipsImage').first().attr('src');
        if (posterUrl && posterUrl.startsWith('//')) {
            posterUrl = 'https:' + posterUrl;
        }

        const magnets = [];
        $('a[href^="magnet:"]').each((i, elem) => {
            let magnetUri = $(elem).attr('href');
            
            // --- START OF FIX for concatenated magnets ---
            // Split the href attribute by 'magnet:?' to handle multiple URIs in one attribute
            const potentialMagnets = magnetUri.split('magnet:?').filter(Boolean);
            
            for (let part of potentialMagnets) {
                // Re-add the prefix to make it a valid URI again
                const singleMagnet = 'magnet:?' + part.trim();
                
                if (singleMagnet.startsWith('magnet:?xt=urn:btih:')) {
                    const sanitizedUri = DOMPurify.sanitize(singleMagnet);
                    magnets.push(sanitizedUri);
                }
            }
            // --- END OF FIX ---
        });

        if (magnets.length === 0) {
            logger.warn({ url, title }, "No valid magnet links found on thread page.");
        }

        return {
            title,
            posterUrl,
            magnets: [...new Set(magnets)], // Ensure final list is unique
            timestamp: new Date().toISOString(),
        };
    } catch (error) {
        logger.error({ err: error.message, url }, "Error parsing thread HTML.");
        return null;
    }
}

module.exports = { parseThreadPage };
