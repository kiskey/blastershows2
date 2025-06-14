// src/parser/titleParser.js

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;
const LANG_MAP = {
    tam: 'ta', mal: 'ml', tel: 'te', hin: 'hi', eng: 'en', kor: 'ko', jap: 'ja',
    tamil: 'ta', malayalam: 'ml', telugu: 'te', hindi: 'hi', english: 'en', korean: 'ko', japanese: 'ja', chi: 'zh'
};

// --- THE FINAL MASTER REGEX LIST ---
const PARSING_PATTERNS = [
    // Case 1: Packs like S01EP(01-13) or S01 EP (01-15)
    {
        regex: /S(\d{1,2})\s?EP\s?\((\d{1,2})[-‑](\d{1,2})\)/i,
        type: 'EPISODE_PACK'
    },
    // Case 2: Packs like S02EP01-07
    {
        regex: /S(\d{1,2})EP(\d{1,2})[-‑](\d{1,2})/i,
        type: 'EPISODE_PACK'
    },
    // Case 3: Packs like S01E01-E16
    {
        regex: /S(\d{1,2})E(\d{1,2})[-‑]E(\d{1,2})/i,
        type: 'EPISODE_PACK'
    },
    // Case 4: Single Episodes like S01 EP(06)
    {
        regex: /S(\d{1,2})\s?EP\((\d{1,2})\)/i,
        type: 'SINGLE_EPISODE'
    },
    // Case 5: Any remaining SXXEXX format
    {
        regex: /S(\d{1,2})E(\d{1,2})/i,
        type: 'SINGLE_EPISODE'
    },
    // Case 6: Season-only packs like S1 or S02
    {
        regex: /(?:S|Season)\s*(\d{1,2})(?!E|\d)/i, // Negative lookahead to ensure it's not followed by 'E' or another digit
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

    const ptt = parse(titleToParse);
    let season = ptt.season;
    let episodes = [];

    for (const pattern of PARSING_PATTERNS) {
        const match = titleToParse.match(pattern.regex);
        if (match) {
            season = parseInt(match[1], 10);
            if (pattern.type === 'EPISODE_PACK') {
                const startEp = parseInt(match[2], 10);
                const endEp = parseInt(match[3], 10);
                if (!isNaN(startEp) && !isNaN(endEp)) {
                    for (let i = startEp; i <= endEp; i++) { episodes.push(i); }
                }
            } else if (pattern.type === 'SINGLE_EPISODE') {
                const ep = parseInt(match[2], 10);
                if (!isNaN(ep)) { episodes.push(ep); }
            }
            // For SEASON_PACK, we just need the season, episodes remain empty.
            
            if (season && (episodes.length > 0 || pattern.type === 'SEASON_PACK')) {
                break; // We found a definitive match, stop processing.
            }
        }
    }

    // If after all our regexes we have nothing, do one last check on the ptt result
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
    cleanTitle = cleanTitle.replace(/\[[^\]]+\]/g, '');
    cleanTitle = cleanTitle.replace(/[()]/g, '');

    return cleanTitle.trim().toLowerCase();
}

module.exports = { parseTitle, normalizeBaseTitle };
