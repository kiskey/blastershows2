// src/parser/titleParser.js

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;
const LANG_MAP = { /* ... unchanged ... */ };

// --- THE ULTIMATE MASTER REGEX LIST ---
const PARSING_PATTERNS = [
    // Case 1: Packs like S01EP(01-13), S01 EP (01-15), S01(E01-26)
    { regex: /S(\d{1,2})\s?EP?\s?\((\d{1,3})[-‑](\d{1,3})\)/i, type: 'EPISODE_PACK' },
    // Case 2: Packs like S02EP01-07 or S01E01-E16
    { regex: /S(\d{1,2})\s?E(\d{1,3})[-‑]E?(\d{1,3})/i, type: 'EPISODE_PACK' },
    // Case 3: Packs like S01EP01-04 (no space)
    { regex: /S(\d{1,2})EP(\d{1,3})[-‑](\d{1,3})/i, type: 'EPISODE_PACK' },
    // Case 4: Single Episodes like S01EP16 or S02 EP(06)
    { regex: /S(\d{1,2})\s?EP\(?(\d{1,3})\)?(?!-)/i, type: 'SINGLE_EPISODE' },
    // Case 5: Season-only packs like S1, S02, or titles with "Complete"
    { regex: /(?:S|Season)\s*(\d{1,2})(?!\s?E|\s?\d)|(Complete)/i, type: 'SEASON_PACK' }
];

function parseTitle(magnetUri) {
    // ... logic from previous final version is already robust enough with the new regexes ...
    // This function will correctly use the new patterns.
    // Full code provided for completeness.
    const infoHashMatch = magnetUri.match(BTIH_REGEX);
    if (!infoHashMatch) return null;
    const infoHash = infoHashMatch[1].toLowerCase();

    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) return null;

    const ptt = parse(titleToParse);
    let season = ptt.season;
    let episodes = [];

    for (const pattern of PARSING_PATTERNS) {
        const match = titleToParse.match(pattern.regex);
        if (match) {
            if (pattern.type === 'EPISODE_PACK') {
                season = parseInt(match[1], 10);
                const startEp = parseInt(match[2], 10);
                const endEp = parseInt(match[3], 10);
                if (!isNaN(startEp) && !isNaN(endEp)) {
                    episodes = Array.from({ length: endEp - startEp + 1 }, (_, i) => startEp + i);
                }
            } else if (pattern.type === 'SINGLE_EPISODE') {
                season = parseInt(match[1], 10);
                const ep = parseInt(match[2], 10);
                if (!isNaN(ep)) { episodes.push(ep); }
            } else if (pattern.type === 'SEASON_PACK') {
                season = parseInt(match[1], 10) || (ptt.season || 1);
            }
            if (season && (episodes.length > 0 || pattern.type === 'SEASON_PACK')) {
                break;
            }
        }
    }

    if (!season && episodes.length === 0 && ptt.episode) {
        season = ptt.season || 1;
        episodes.push(ptt.episode);
    }
    
    const resolution = ptt.resolution || 'N/A';
    const sizeMatch = titleToParse.match(/(\d+(\.\d+)?\s*(GB|MB))/i);
    const size = sizeMatch ? sizeMatch[0] : 'N/A';
    const finalLanguages = getLanguages(titleToParse, ptt.languages);

    return {
        infoHash, name: titleToParse.replace(/\s+/g, ' ').trim(), title: ptt.title,
        year: ptt.year, season, episodes, resolution, languages: finalLanguages, size
    };
}

function getLanguages(title, pttLangs = []) { /* ... unchanged ... */ }

function normalizeBaseTitle(title) {
    if (!title) return '';
    const ptt = parse(title);
    let cleanTitle = ptt.title && ptt.title.length > 3 ? ptt.title : title;
    
    cleanTitle = cleanTitle.replace(/\b(S\d+|Season\s*\d+|E\d+|Episode\s*\d+|Complete)\b/gi, '');
    cleanTitle = cleanTitle.replace(/\b((19|20)\d{2})\b/g, '');
    cleanTitle = cleanTitle.replace(/\[[^\]]+\]/g, '');
    cleanTitle = cleanTitle.replace(/\([^)]+\)/g, '');
    cleanTitle = cleanTitle.replace(/[...]/g, ' ');
    cleanTitle = cleanTitle.replace(/[-_]/g, ' ');

    return cleanTitle.trim().replace(/\s+/g, ' ').toLowerCase();
}

module.exports = { parseTitle, normalizeBaseTitle };
