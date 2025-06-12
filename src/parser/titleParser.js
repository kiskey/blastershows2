// src/parser/titleParser.js

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;
const LANG_MAP = {
    tam: 'ta', mal: 'ml', tel: 'te', hin: 'hi', eng: 'en', kor: 'ko', jap: 'ja',
    tamil: 'ta', malayalam: 'ml', telugu: 'te', hindi: 'hi', english: 'en', korean: 'ko', japanese: 'ja', chi: 'zh'
};

// A comprehensive set of regexes for packs. They are designed to be very specific.
const PACK_REGEX_PATTERNS = [
    /S(\d{1,2})\s?EP?\(?(\d{1,2})[-‑](\d{1,2})\)?/i,      // S01EP(01-09), S01E01-09, S01(01-09), S01(E01-26)
    /S(\d{1,2})\s?(\d{1,2})[-‑](\d{1,2})/i,             // S01 01-24 (no E)
    /S(\d{1,2})EP(\d{1,2})[-‑](\d{1,2})/i,              // S01EP01-04 (no space, no parens)
];

function parseTitle(magnetUri) {
    const infoHashMatch = magnetUri.match(BTIH_REGEX);
    if (!infoHashMatch) return null;
    const infoHash = infoHashMatch[1].toLowerCase();

    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) return null;

    // --- START OF NEW, SIMPLIFIED LOGIC ---

    // 1. Get a baseline parse from the library. This is our primary source of truth.
    const ptt = parse(titleToParse);
    let season = ptt.season;
    let episodes = ptt.episode ? [ptt.episode] : [];

    // 2. Check if this is a pack, which our regexes are better at.
    // If a pack regex matches, we overwrite the library's episode result.
    for (const regex of PACK_REGEX_PATTERNS) {
        const match = titleToParse.match(regex);
        if (match) {
            // The regex found a pack, so we trust its season and episode range.
            season = parseInt(match[1], 10);
            const startEp = parseInt(match[2], 10);
            const endEp = parseInt(match[3], 10);
            
            if (!isNaN(startEp) && !isNaN(endEp)) {
                episodes = []; // Clear any single episode found by ptt
                for (let i = startEp; i <= endEp; i++) {
                    episodes.push(i);
                }
                // We found a pack, so we can stop.
                break;
            }
        }
    }
    // --- END OF NEW, SIMPLIFIED LOGIC ---

    // --- Other metadata parsing (remains the same) ---
    const resolution = ptt.resolution || 'N/A';
    const sizeMatch = titleToParse.match(/(\d+(\.\d+)?\s*(GB|MB))/i);
    const size = sizeMatch ? sizeMatch[0] : 'N/A';
    const finalLanguages = getLanguages(titleToParse, ptt.languages);

    return {
        infoHash,
        name: titleToParse.replace(/\s+/g, ' ').trim(),
        title: ptt.title,
        year: ptt.year,
        season, // This will be the season from ptt, or overwritten by our regex
        episodes, // This will be the episode from ptt, or the full range from our regex
        resolution,
        languages: finalLanguages,
        size
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
