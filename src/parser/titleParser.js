const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;

// Language map for converting to 2-letter codes
const LANG_MAP = {
    tam: 'ta', mal: 'ml', tel: 'te', hin: 'hi', eng: 'en', kor: 'ko',
    tamil: 'ta', malayalam: 'ml', telugu: 'te', hindi: 'hi', english: 'en', korean: 'ko'
};

/**
 * Parses all possible metadata from a torrent title/magnet URI.
 * @param {string} magnetUri - The magnet URI.
 * @returns {object|null} Parsed metadata or null if invalid.
 */
function parseTitle(magnetUri) {
    const infoHashMatch = magnetUri.match(BTIH_REGEX);
    if (!infoHashMatch) {
        logger.warn({ magnet: magnetUri }, 'Invalid magnet URI: No BTIH found.');
        return null;
    }
    const infoHash = infoHashMatch[1].toLowerCase();

    // Extract display name (dn) for parsing
    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) {
        logger.warn({ magnet: magnetUri }, 'Magnet URI has no display name (dn) to parse.');
        return null; // Cannot parse without a title
    }
    
    // Use parse-torrent-title for a good base
    const ptt = parse(titleToParse);

    // Custom parsing to refine results
    const resolution = ptt.resolution || 'N/A';
    const quality = ptt.source || 'N/A';
    const sizeMatch = titleToParse.match(/(\d+(\.\d+)?\s*(GB|MB))/i);
    const size = sizeMatch ? sizeMatch[0] : 'N/A';

    // Advanced Language Parsing
    const langMatches = titleToParse.toLowerCase().matchAll(/(tam|mal|tel|hin|eng|kor)(il|ugu|alam|di|ish)?/g);
    let languages = new Set(ptt.languages || []);
    for (const match of langMatches) {
        const langKey = match[1];
        if (LANG_MAP[langKey]) {
            languages.add(LANG_MAP[langKey]);
        }
    }
    // Handle format like [tam+mal]
    const bracketLangMatch = titleToParse.match(/\[([^\]]+)\]/);
    if (bracketLangMatch) {
        const langsInBrackets = bracketLangMatch[1].split(/[+,\s]/);
        langsInBrackets.forEach(lang => {
            const shortLang = lang.trim().substring(0, 3).toLowerCase();
            if (LANG_MAP[shortLang]) {
                languages.add(LANG_MAP[shortLang]);
            }
        });
    }

    const finalLanguages = languages.size > 0 ? Array.from(languages) : ['en']; // Default to English if none found

    // The name becomes the full title from the magnet
    const name = titleToParse.replace(/\s+/g, ' ').trim();
    
    return {
        infoHash,
        name,
        title: ptt.title,
        year: ptt.year,
        resolution,
        quality,
        languages: finalLanguages,
        size
        // Since we treat everything as a movie, season/episode are not returned here
        // The stream is identified by its hash and belongs to the movieKey.
    };
}

/**
 * Normalizes a show title into a consistent format for use in an ID.
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
    if (!title) return '';
    return title
        .toLowerCase()
        .replace(/\b(19|20)\d{2}\b/g, '') // Remove years
        .replace(/season|s\d+|episode|e\d+/g, '') // Remove season/episode indicators
        .replace(/[^\w\s]/g, '') // Remove non-alphanumeric chars except space
        .replace(/\s+/g, ' ') // Collapse whitespace
        .trim();
}

module.exports = { parseTitle, normalizeTitle };
