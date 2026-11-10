import { describe, expect, it } from 'vitest';
import { mafiaDefinition } from '../index';
describe('mafia registration', () => {
  it('validates default settings and rejects unknown options', () => {
    expect(mafiaDefinition.settingsSchema.safeParse({}).success).toBe(true);
    expect(mafiaDefinition.settingsSchema.safeParse({ clientBalance: 100 }).success).toBe(false);
    expect(mafiaDefinition.info.status).toBe('planned');
  });
});
