import { GameRegistry } from '@rize/platform-core';
import { durakModule } from '@rize/durak';
import { unoDefinition } from '@rize/uno';
import { mafiaDefinition } from '@rize/mafia';
import { sandboxModule } from '@rize/sandbox';
export function createGameRegistry(enableTestGame = false): GameRegistry {
  const registry = new GameRegistry().registerModule(durakModule).register(unoDefinition).register(mafiaDefinition);
  if (enableTestGame) registry.registerModule(sandboxModule);
  return registry;
}
