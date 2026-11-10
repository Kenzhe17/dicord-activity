import { describe, expect, it } from 'vitest';
import { unoDefinition } from '../index';
describe('uno registration', () => {
  it('validates default settings and rejects unknown options', () => {
    expect(unoDefinition.settingsSchema.safeParse({}).success).toBe(true);
    expect(unoDefinition.settingsSchema.safeParse({ clientBalance: 100 }).success).toBe(false);
    expect(unoDefinition.info.status).toBe('planned');
  });
});
