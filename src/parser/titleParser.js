// src/parser/titleParser.js

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;

const LANG_MAP = {
    tam: 'ta', mal: 'ml', tel: 'te', hin: 'hi', eng: 'en', kor: 'ko',
    tamil: 'ta', malayalam: 'ml', telugu: 'te', hindi: 'hi', english: 'en', korean: 'ko'
};

// --- START OF NEW REGEX PATTERNS ---
// Pattern 1: S01EP(01-09) or S01 EP(01-09)
const SXXEP_XX_XX_REGEX = /S(\d{1,2})\s?EP\((\d{1,2})-(\d{1,2})\)/i;
// Pattern 2: S01 E01-E09
const SXX_EXX_EXX_REGEX = /S(\d{1,2})\s?E(\d{1,2})-E?(\d{1,2})/i;
// --- END OF NEW REGEX PATTERNS ---

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

    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) {
        return null;
    }
    
    // 1. Use the library for a base parse
    const ptt = parse(titleToParse);

    let season = ptt.season;
    let episodes = [];

    // 2. Augment with our custom regex if the library fails on episodes
    if (ptt.episode) {
        if (ptt.to_episode) {
            for (let i = ptt.episode; i <= ptt.to_episode; i++) {
                episodes.push(i);
            }
        } else {
            episodes.push(ptt.episode);
        }
    } else {
        // Library failed, try our custom regex patterns
        let match = titleToParse.match(SXXEP_XX_XX_REGEX) || titleToParse.match(SXX_EXX_EXX_REGEX);
        if (match) {
            season = parseInt(match[1], 10);
            const startEp = parseInt(match[2], 10);
            const endEp = parseInt(match[3], 10);
            for (let i = startEp; i <= endEp; i++) {
                episodes.push(i);
            }
        }
    }

    // --- Other metadata parsing (remains the same) ---
    const resolution = ptt.resolution || 'N/A';
    const sizeMatch = titleToParse.match(/(\d+(\.\d+)?\s*(GB|MB))/i);
    const size = sizeMatch ? sizeMatch[0] : 'N/A';
    
    let languages = new Set(ptt.languages || []);
    const langMatches = titleToParse.toLowerCase().matchAll(/(tam|mal|tel|hin|eng|kor)(il|ugu|alam|di|ish)?/g);
    for (const match of langMatches) {
        if (LANG_MAP[match[1]]) languages.add(LANG_MAP[match[1]]);
    }
    const bracketLangMatch = titleToParse.match(/\[([^\]]+)\]/);
    if (bracketLangMatch) {
        const langsInBrackets = bracketLangMatch[1].split(/[+,\s]/);
        langsInBrackets.forEach(lang => {
            const shortLang = lang.trim().substring(0, 3).toLowerCase();
            if (LANG_MAP[shortLang]) languages.add(LANG_MAP[shortLang]);
        });
    }
    const finalLanguages = languages.size > 0 ? Array.from(languages) : ['en'];

    return {
        infoHash,
        name: titleToParse.replace(/\s+/g, ' ').trim(),
        title: ptt.title,
        year: ptt.year,
        season, // Use the potentially corrected season
        episodes, // Use the potentially corrected episodes array
        resolution,
        languages: finalLanguages,
        size
    };
}

// ... normalizeBaseTitle function remains the same ...
function normalizeBaseTitle(title) {
    if (!title) return '';

    const ptt = parse(title);
    
    let cleanTitle = ptt.title && ptt.title.length > 3 ? ptt.title : title;

    cleanTitle = cleanTitle.replace(/\b((19|20)\d{2}|S\d+|Season\s*\d+|E\d+|Episode\s*\d+)\b.*$/i, '');
    
    return cleanTitle
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

module.exports = { parseTitle, normalizeBaseTitle };
