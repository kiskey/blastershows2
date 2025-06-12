// src/parser/titleParser.js (Updated)

const { parse } = require('parse-torrent-title');
const logger = require('../utils/logger');

// ... (BTIH_REGEX and LANG_MAP remain the same) ...

function parseTitle(magnetUri) {
    // ... (This function remains largely the same, but we will ensure it handles episodes) ...
    const infoHashMatch = magnetUri.match(BTIH_REGEX);
    if (!infoHashMatch) return null;
    const infoHash = infoHashMatch[1].toLowerCase();

    const dnMatch = magnetUri.match(/&dn=([^&]+)/);
    const titleToParse = dnMatch ? decodeURIComponent(dnMatch[1]).replace(/\+/g, ' ') : '';
    if (!titleToParse) return null;
    
    const ptt = parse(titleToParse);

    // ... (All language, quality, size, resolution parsing remains the same) ...

    // IMPORTANT: Handle episode ranges
    let episodes = [];
    if (ptt.episode) {
        if (ptt.to_episode) {
            for (let i = ptt.episode; i <= ptt.to_episode; i++) {
                episodes.push(i);
            }
        } else {
            episodes.push(ptt.episode);
        }
    }

    const finalLanguages = ptt.languages && ptt.languages.length > 0 ? ptt.languages : ['en'];

    return {
        infoHash,
        name: titleToParse.replace(/\s+/g, ' ').trim(),
        title: ptt.title,
        season: ptt.season,
        episodes, // This is now an array of episode numbers
        resolution: ptt.resolution || 'N/A',
        languages: finalLanguages,
        size: ptt.size || 'N/A',
    };
}

/**
 * Normalizes a show title by stripping away season, episode, year, and quality info.
 * @param {string} title - The original thread title
 * @returns {string} - The clean, normalized base title
 */
function normalizeBaseTitle(title) {
    if (!title) return '';

    // First, try to use parse-torrent-title to get a clean base title
    const ptt = parse(title);
    
    // If PTT gives a good title, use it. Otherwise, fall back to regex.
    let cleanTitle = ptt.title;

    if (!cleanTitle || cleanTitle.length < 4) {
      // Fallback Regex Method
      // Remove everything from the year or season/episode indicators onwards
      cleanTitle = title.replace(/\b((19|20)\d{2}|S\d+|Season\s*\d+|E\d+|Episode\s*\d+)\b.*$/i, '');
    }

    // Final cleanup
    return cleanTitle
        .replace(/[^\w\s]/g, '') // Remove non-alphanumeric chars except space
        .replace(/\s+/g, ' ') // Collapse whitespace
        .trim()
        .toLowerCase();
}

// Rename the old normalizeTitle to avoid confusion
module.exports = { parseTitle, normalizeBaseTitle };
