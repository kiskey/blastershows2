// src/parser/titleParser.js

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;
const LANG_MAP = { /* ... no change ... */ };

// --- A more comprehensive and organized set of regexes ---
const EPISODE_PACK_REGEX = [
    /S(\d{1,2})\s?EP?\(?(\d{1,2})[-‑](\d{1,2})\)?/i, // S01EP(01-09), S01E01-09, S01(01-09)
    /S(\d{1,2})\s?(\d{1,2})[-‑](\d{1,2})/i,             // S01 01-24 (no E)
];
const SINGLE_EPISODE_REGEX = [
    /S(\d{1,2})\s?EP\(?(\d{1,2})\)?/i, // S01EP(01), S01 E01
    /S(\d{1,2})EP(\d{1,2})/i,         // S01EP01 (no space)
];

function parseTitle(magnetUri) {
    const infoHashMatch = magnetUri.match(BTIH_REGEX);
    if (!infoHashMatch) return null;
    const infoHash = infoHashMatch[1].toLowerCase();

    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) return null;

    // 1. Get a baseline parse from the library
    const ptt = parse(titleToParse);
    let season = ptt.season;
    let episodes = ptt.episode ? [ptt.episode] : [];

    // 2. Try to find a more specific episode pack match
    let packFound = false;
    for (const regex of EPISODE_PACK_REGEX) {
        const match = titleToParse.match(regex);
        if (match) {
            season = parseInt(match[1], 10);
            const startEp = parseInt(match[2], 10);
            const endEp = parseInt(match[3], 10);
            if (!isNaN(startEp) && !isNaN(endEp)) {
                episodes = []; // Clear any previous result
                for (let i = startEp; i <= endEp; i++) { episodes.push(i); }
                packFound = true;
                break;
            }
        }
    }

    // 3. If no pack was found, try to find a more specific single episode match
    if (!packFound) {
        for (const regex of SINGLE_EPISODE_REGEX) {
            const match = titleToParse.match(regex);
            if (match) {
                season = parseInt(match[1], 10);
                const ep = parseInt(match[2], 10);
                 if (!isNaN(ep)) {
                    episodes = [ep];
                }
                break;
            }
        }
    }

    // --- Other metadata ---
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
    const langMatches = title.toLowerCase().matchAll(/(tam|mal|tel|hin|eng|kor|jap)/g);
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

// ... normalizeBaseTitle is unchanged ...
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
