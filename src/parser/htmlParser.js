const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const logger = require('../utils/logger');

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

function parseThreadPage(html, url) {
    try {
        const $ = cheerio.load(html);

        // Extract title
        const title = $('span.ipsType_break.ipsContained').first().text().trim();
        if (!title) {
            logger.warn({ url }, 'Could not find title element on page.');
            return null;
        }

        // Extract poster
        let posterUrl = $('img.ipsImage').first().attr('src');
        if (posterUrl && posterUrl.startsWith('//')) {
            posterUrl = 'https:' + posterUrl;
        }

        // Extract magnet links
        const magnets = [];
        $('a.magnet-plugin').each((i, elem) => {
            const magnetUri = $(elem).attr('href');
            // Basic validation for magnet URI
            if (magnetUri && magnetUri.startsWith('magnet:?xt=urn:btih:')) {
                const sanitizedUri = DOMPurify.sanitize(magnetUri);
                magnets.push(sanitizedUri);
            }
        });

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
