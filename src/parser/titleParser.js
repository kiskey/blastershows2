// src/parser/titleParser.js

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

const BTIH_REGEX = /btih:([a-fA-F0-9]{40})/;
const LANG_MAP = {
    tam: 'ta', mal: 'ml', tel: 'te', hin: 'hi', eng: 'en', kor: 'ko', jap: 'ja',
    tamil: 'ta', malayalam: 'ml', telugu: 'te', hindi: 'hi', english: 'en', korean: 'ko', japanese: 'ja', chi: 'zh'
};

const PARSING_PATTERNS = [
    // Case 1: Packs like S01EP(01-13) or S01 EP (01-15) or S01(E01-26)
    { regex: /S(\d{1,2})\s?EP?\s?\((\d{1,3})[-‑](\d{1,3})\)/i, type: 'EPISODE_PACK' },
    // Case 2: Packs like S02EP01-07 or S01E01-E16
    { regex: /S(\d{1,2})\s?E(\d{1,3})[-‑]E?(\d{1,3})/i, type: 'EPISODE_PACK' },
    // Case 3: Packs like S01EP01-04 (no space, no parens)
    { regex: /S(\d{1,2})EP(\d{1,3})[-‑](\d{1,3})/i, type: 'EPISODE_PACK' },
    // Case 4: Packs like S01 (01-24) without an 'E'
    { regex: /S(\d{1,2})\s?\((\d{1,3})[-‑](\d{1,3})\)/i, type: 'EPISODE_PACK' },
    // Case 5: Single Episodes like S01EP16, S02 EP(06), or S03 EP(07)
    { regex: /S(\d{1,2})\s?EP?\(?(\d{1,3})\)?(?!-)/i, type: 'SINGLE_EPISODE' },
    // Case 6: Season-only packs like S1, S02, or titles with "Complete"
    { regex: /(?:S|Season)\s*(\d{1,2})(?!\s?E|\s?\d)|(Complete)/i, type: 'SEASON_PACK' }
];

function parseTitle(magnetUri) {
    const infoHashMatch = magnetUri.match(BTIH_REGEX);
    if (!infoHashMatch) return null;
    const infoHash = infoHashMatch[1].toLowerCase();

    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) return null;

    const ptt = parse(titleToParse);
    let season = null;
    let episodes = [];

    for (const pattern of PARSING_PATTERNS) {
        const match = titleToParse.match(pattern.regex);
        if (match) {
            if (pattern.type === 'SEASON_PACK') {
                season = parseInt(match[1]) || (ptt.season || 1);
            } else if (pattern.type === 'SINGLE_EPISODE') {
                season = parseInt(match[1]);
                const ep = parseInt(match[2]);
                if (!isNaN(ep)) { episodes = [ep]; }
            } else if (pattern.type === 'EPISODE_PACK') {
                season = parseInt(match[1]);
                const startEp = parseInt(match[2]);
                const endEp = parseInt(match[3]);
                if (!isNaN(startEp) && !isNaN(endEp)) {
                    episodes = Array.from({ length: endEp - startEp + 1 }, (_, i) => startEp + i);
                }
            }
            if (season && (episodes.length > 0 || pattern.type === 'SEASON_PACK')) {
                break;
            }
        }
    }

    if (!season && episodes.length === 0) {
        if (ptt.season) season = ptt.season;
        if (ptt.episode) episodes.push(ptt.episode);
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

// --- THE DEFINITIVE, FINAL, CORRECT NORMALIZER ---
function normalizeBaseTitle(title) {
    if (!title) return '';
    
    // 1. Use the library as the first pass to get the most likely title candidate.
    const ptt = parse(title);
    let cleanTitle = ptt.title || title;

    // 2. Remove the year, which is often attached to the title.
    cleanTitle = cleanTitle.replace(/\b((19|20)\d{2})\b/g, '');
    
    // 3. Remove common junk keywords and file extensions.
    // The \b ensures we only match whole words.
    const junkWords = /\b(tamil|hindi|telugu|english|uncut|complete|s\d+|season|ep|episode|web-dl|hdrip|hd|avc|x264|aac|ddp5 1|mkv|mp4)\b/gi;
    cleanTitle = cleanTitle.replace(junkWords, '');
    
    // 4. Remove any content inside brackets or parentheses.
    cleanTitle = cleanTitle.replace(/\[[^\]]+\]/g, '');
    cleanTitle = cleanTitle.replace(/\([^)]+\)/g, '');
    
    // 5. Clean up remaining special characters and extra spaces.
    cleanTitle = cleanTitle
        .replace(/[._-]/g, ' ') // replace separators with spaces
        .replace(/\s+/g, ' ')  // collapse multiple spaces
        .trim();

    return cleanTitle.toLowerCase();
}

module.exports = { parseTitle, normalizeBaseTitle };
