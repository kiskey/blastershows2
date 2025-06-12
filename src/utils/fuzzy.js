const { JaroWinklerDistance, PorterStemmer } = require('natural');

const FUZZY_THRESHOLD = 0.85;

/**
 * Normalizes a title for fuzzy matching or creating a unique ID.
 * @param {string} title
 * @returns {string}
 */
function normalizeTitleForId(title) {
    if (!title) return '';
    return title
        .toLowerCase()
        // Remove special characters, keeping only letters, numbers, and spaces
        .replace(/[^a-z0-9\s]/g, '')
        // Replace synonyms or common patterns
        .replace(/\bseason\b/g, 's')
        .replace(/\bepisode\b/g, 'ep')
        // Collapse multiple spaces into one
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Compares two titles using Jaro-Winkler similarity.
 * @param {string} title1
 * @param {string} title2
 * @returns {boolean}
 */
function areTitlesSimilar(title1, title2) {
    const normalized1 = normalizeTitleForId(title1);
    const normalized2 = normalizeTitleForId(title2);
    
    const stemmed1 = normalized1.split(' ').map(token => PorterStemmer.stem(token)).join(' ');
    const stemmed2 = normalized2.split(' ').map(token => PorterStemmer.stem(token)).join(' ');
    
    const similarity = JaroWinklerDistance(stemmed1, stemmed2, { ignoreCase: true });
    
    return similarity >= FUZZY_THRESHOLD;
}


module.exports = {
    normalizeTitleForId,
    areTitlesSimilar
};
