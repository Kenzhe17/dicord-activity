import { describe, expect, it } from 'vitest';
import { unoDefinition } from '../index';
import { unoModule } from '../server/module';

describe('uno registration', () => {
  it('validates default settings and rejects unknown options', () => {
    expect(unoDefinition.settingsSchema.safeParse({}).success).toBe(true);
    expect(unoDefinition.settingsSchema.safeParse({ clientBalance: 100 }).success).toBe(false);
    expect(unoDefinition.info.status).toBe('planned');
  });
  it('exposes a ready module with capacity settings', () => {
    expect(unoModule.info.status).toBe('ready');
    expect(unoModule.info.id).toBe('uno');
    expect(unoModule.getRoomCapacity?.({ mode: 'points', target: 500, maxPlayers: 6 })).toBe(6);
  });
});
