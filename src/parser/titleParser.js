// src/parser/titleParser.js

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
    // ---- THIS IS THE FIX ----
    const infoHashMatch = magnetUri.match(BTIH_REGEX); 
    // ---- END OF FIX ----

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
        return null;
    }
    
    // Use parse-torrent-title for a good base
    const ptt = parse(titleToParse);

    // Custom parsing to refine results
    const resolution = ptt.resolution || 'N/A';
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

    // IMPORTANT: Handle episode ranges
    let episodes = [];
    if (ptt.episode) {
        // Handle format like E01-E10
        if (ptt.to_episode) {
            for (let i = ptt.episode; i <= ptt.to_episode; i++) {
                episodes.push(i);
            }
        } else {
            episodes.push(ptt.episode);
        }
    }

    const name = titleToParse.replace(/\s+/g, ' ').trim();
    
    return {
        infoHash,
        name,
        title: ptt.title,
        year: ptt.year,
        season: ptt.season,
        episodes, // This is now an array of episode numbers [1], or [1, 2, 3] etc.
        resolution,
        languages: finalLanguages,
        size
    };
}

/**
 * Normalizes a show title by stripping away season, episode, year, and quality info.
 * This is used to create the main "movie key".
 * @param {string} title - The original thread title (e.g., from the <h1> tag)
 * @returns {string} - The clean, normalized base title (e.g., "mercy for none")
 */
function normalizeBaseTitle(title) {
    if (!title) return '';

    // First, try to use parse-torrent-title to get a clean base title.
    // This is effective at removing quality, codec, etc.
    const ptt = parse(title);
    
    // Use the title from PTT if it's valid, otherwise fall back to the original.
    let cleanTitle = ptt.title && ptt.title.length > 3 ? ptt.title : title;

    // Fallback Regex Method to be safe:
    // Remove everything from the year or season/episode indicators onwards.
    // This cleans up titles that PTT might misinterpret.
    cleanTitle = cleanTitle.replace(/\b((19|20)\d{2}|S\d+|Season\s*\d+|E\d+|Episode\s*\d+)\b.*$/i, '');
    
    // Final cleanup
    return cleanTitle
        .replace(/[^\p{L}\p{N}\s]/gu, '') // Remove punctuation but keep letters from various languages and numbers
        .replace(/\s+/g, ' ') // Collapse whitespace
        .trim()
        .toLowerCase();
}


module.exports = { parseTitle, normalizeBaseTitle };
