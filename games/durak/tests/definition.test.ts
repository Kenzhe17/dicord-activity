import { describe, expect, it } from 'vitest';
import { durakDefinition } from '../index';
describe('durak registration', () => {
  it('validates default settings and rejects unknown options', () => {
    expect(durakDefinition.settingsSchema.safeParse({}).success).toBe(true);
    expect(durakDefinition.settingsSchema.safeParse({ clientBalance: 100 }).success).toBe(false);
    expect(durakDefinition.info.status).toBe('planned');
  });
});
