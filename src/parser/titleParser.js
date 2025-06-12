// src/parser/titleParser.js

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;
const LANG_MAP = { /* ... remains the same ... */ };

// --- Simplified and more robust regex patterns ---
const REGEX_PATTERNS = [
    // Matches S01 EP(01-09) or S01EP(01-09)
    /S(\d{1,2})\s?EP\((\d{1,2})-(\d{1,2})\)/i,
    // Matches S01 E01-09 or S01E01-E09 or S01E01-09
    /S(\d{1,2})\s?E(\d{1,2})[-‑]E?(\d{1,2})/i, // Added hyphen variant
    // Matches S01EP01-04 (no space, no parentheses)
    /S(\d{1,2})EP(\d{1,2})[-‑](\d{1,2})/i, // Added hyphen variant
];

function parseTitle(magnetUri) {
    const infoHashMatch = magnetUri.match(BTIH_REGEX);
    if (!infoHashMatch) { return null; }
    const infoHash = infoHashMatch[1].toLowerCase();

    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) { return null; }

    const ptt = parse(titleToParse);
    let season = ptt.season;
    let episodes = [];

    let matched = false;
    for (const regex of REGEX_PATTERNS) {
        const match = titleToParse.match(regex);
        if (match) {
            season = parseInt(match[1], 10);
            const startEp = parseInt(match[2], 10);
            const endEp = parseInt(match[3], 10);
            if (!isNaN(startEp) && !isNaN(endEp)) {
                for (let i = startEp; i <= endEp; i++) { episodes.push(i); }
                matched = true;
                break;
            }
        }
    }

    if (!matched && ptt.episode) {
        episodes.push(ptt.episode);
    }

    // If after all that, we still have no episodes, check for a season-only pack like "S01".
    if (episodes.length === 0 && season && !titleToParse.match(/E\d+/i)) {
        // This indicates a season pack, episodes array should remain empty
    }
    
    // ... rest of the function is the same ...
    const resolution = ptt.resolution || 'N/A';
    const sizeMatch = titleToParse.match(/(\d+(\.\d+)?\s*(GB|MB))/i);
    const size = sizeMatch ? sizeMatch[0] : 'N/A';
    
    let languages = new Set(ptt.languages || []);
    const langMatches = titleToParse.toLowerCase().matchAll(/(tam|mal|tel|hin|eng|kor)/g);
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
        infoHash, name: titleToParse.replace(/\s+/g, ' ').trim(), title: ptt.title,
        year: ptt.year, season, episodes, resolution, languages: finalLanguages, size
    };
}


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
