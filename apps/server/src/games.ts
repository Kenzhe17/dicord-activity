import { GameRegistry } from '@rize/platform-core';
import { durakModule } from '@rize/durak';
import { unoModule } from '@rize/uno';
import { mafiaDefinition } from '@rize/mafia';
import { sandboxModule } from '@rize/sandbox';
export function createGameRegistry(enableTestGame = false): GameRegistry {
  const registry = new GameRegistry().registerModule(durakModule).registerModule(unoModule).register(mafiaDefinition);
  if (enableTestGame) registry.registerModule(sandboxModule);
  return registry;
}
