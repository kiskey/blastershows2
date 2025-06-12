// src/parser/titleParser.js

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;
const LANG_MAP = {
    tam: 'ta', mal: 'ml', tel: 'te', hin: 'hi', eng: 'en', kor: 'ko', jap: 'ja',
    tamil: 'ta', malayalam: 'ml', telugu: 'te', hindi: 'hi', english: 'en', korean: 'ko', japanese: 'ja', chi: 'zh'
};

// --- THE MASTER REGEX LIST ---
// Ordered from most specific (packs) to least specific (season only)
const PARSING_PATTERNS = [
    // Case 1: Episode Packs (e.g., S01 E01-E09, S01EP(01-09), S01(E01-26), S01 (01-16))
    {
        regex: /S(\d{1,2})\s?(?:E|EP)?\(?(\d{1,2})[-‑](\d{1,2})\)?/i,
        type: 'EPISODE_PACK'
    },
    // Case 2: Single Episodes (e.g., S01 E01, S02EP(04))
    {
        regex: /S(\d{1,2})\s?(?:E|EP)\(?(?!\d+[-‑])(\d{1,2})\)?/i,
        type: 'SINGLE_EPISODE'
    },
    // Case 3: Season Packs (e.g., S01, S1, S2, Season 01)
    {
        regex: /(?:S|Season)\s*(\d{1,2})/i,
        type: 'SEASON_PACK'
    }
];

function parseTitle(magnetUri) {
    const infoHashMatch = magnetUri.match(BTIH_REGEX);
    if (!infoHashMatch) return null;
    const infoHash = infoHashMatch[1].toLowerCase();

    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) return null;

    // Use ptt for non-essential metadata first
    const ptt = parse(titleToParse);

    let season = null;
    let episodes = [];

    // --- START OF NEW PARSING LOGIC ---
    // Loop through our master list of patterns. First match wins.
    for (const pattern of PARSING_PATTERNS) {
        const match = titleToParse.match(pattern.regex);
        if (match) {
            if (pattern.type === 'EPISODE_PACK') {
                season = parseInt(match[1], 10);
                const startEp = parseInt(match[2], 10);
                const endEp = parseInt(match[3], 10);
                if (!isNaN(startEp) && !isNaN(endEp)) {
                    for (let i = startEp; i <= endEp; i++) { episodes.push(i); }
                }
            } else if (pattern.type === 'SINGLE_EPISODE') {
                season = parseInt(match[1], 10);
                const ep = parseInt(match[2], 10);
                if (!isNaN(ep)) {
                    episodes.push(ep);
                }
            } else if (pattern.type === 'SEASON_PACK') {
                season = parseInt(match[1], 10);
                // episodes array remains empty for a season pack
            }
            
            // If we got a valid season, we're done.
            if (season) {
                break;
            }
        }
    }
    // --- END OF NEW PARSING LOGIC ---

    const resolution = ptt.resolution || 'N/A';
    const sizeMatch = titleToParse.match(/(\d+(\.\d+)?\s*(GB|MB))/i);
    const size = sizeMatch ? sizeMatch[0] : 'N/A';
    const finalLanguages = getLanguages(titleToParse, ptt.languages);

    return {
        infoHash, name: titleToParse.replace(/\s+/g, ' ').trim(), title: ptt.title,
        year: ptt.year, season, episodes, resolution, languages: finalLanguages, size
    };
}

function getLanguages(title, pttLangs = []) {
    let languages = new Set(pttLangs);
    const langMatches = title.toLowerCase().matchAll(/(tam|mal|tel|hin|eng|kor|jap|chi)/g);
    for (const match of langMatches) {
        if (LANG_MAP[match[1]]) languages.add(LANG_MAP[match[1]]);
    }
    const bracketLangMatch = title.match(/\[([^\]]+)\]/);
    if (bracketLangMatch) {
        const langsInBrackets = bracketLangMatch[1].split(/[+,\s]/);
        langsInBrackets.forEach(lang => {
            const shortLang = lang.trim().substring(0, 3).toLowerCase();
            if (LANG_MAP[shortLang]) languages.add(LANG_MAP[shortLang]);
        });
    }
    return languages.size > 0 ? Array.from(languages) : ['en'];
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
