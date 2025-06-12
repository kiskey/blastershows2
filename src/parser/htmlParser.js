// src/parser/htmlParser.js

const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const logger = require('../utils/logger');

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

/**
 * Parses the HTML of a thread page to extract title, poster, and magnet links.
 * @param {string} html - The raw HTML of the page.
 * @param {string} url - The URL of the page, for logging purposes.
 * @returns {object|null} An object with parsed data or null if essential data is missing.
 */
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

        // This robust selector finds any <a> tag whose href starts with "magnet:".
        const magnets = [];
        $('a[href^="magnet:"]').each((i, elem) => {
            const magnetUri = $(elem).attr('href');
            
            if (magnetUri && magnetUri.startsWith('magnet:?xt=urn:btih:')) {
                const sanitizedUri = DOMPurify.sanitize(magnetUri);
                magnets.push(sanitizedUri);
            }
        });

        if (magnets.length === 0) {
            logger.warn({ url, title }, "No valid magnet links found on thread page.");
        }

        return {
            title,
            posterUrl,
            magnets,
            timestamp: new Date().toISOString(),
        };
    } catch (error) {
        logger.error({ err: error.message, url }, "Error parsing thread HTML.");
        return null;
    }
}

module.exports = { parseThreadPage };
