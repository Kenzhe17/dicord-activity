import { describe, expect, it } from 'vitest';
import { DICTIONARIES, DICTIONARY_VERSION, RUSSIAN_WORDS, getDictionary } from '../engine/words';

describe('Codenames dictionary', () => {
  it('ships at least 1000 unique, well-formed lowercase words', () => {
    expect(RUSSIAN_WORDS.length).toBeGreaterThanOrEqual(1000);
    expect(new Set(RUSSIAN_WORDS).size).toBe(RUSSIAN_WORDS.length);
    for (const word of RUSSIAN_WORDS) {
      expect(word).toMatch(/^[а-яёa-z][а-яёa-z'’-]*$/);
      expect(word).toBe(word.toLowerCase());
      expect(word.length).toBeLessThanOrEqual(30);
    }
  });
  it('exposes the dictionary through the registry', () => {
    expect(DICTIONARY_VERSION).toBe('ru-1.0.0');
    expect(getDictionary('ru').words).toBe(RUSSIAN_WORDS);
    expect(getDictionary('ru').version).toBe(DICTIONARY_VERSION);
    expect(DICTIONARIES['ru']!.words).toBe(RUSSIAN_WORDS);
    expect(getDictionary('xx')).toBe(DICTIONARIES['ru']);
  });
});
