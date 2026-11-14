import { GameRegistry } from '@rize/platform-core';
import { durakModule } from '@rize/durak';
import { codenamesModule } from '@rize/codenames';
import { unoModule } from '@rize/uno';
import { mafiaDefinition } from '@rize/mafia';
import { sandboxModule } from '@rize/sandbox';
export function createGameRegistry(enableTestGame = false): GameRegistry {
  const registry = new GameRegistry().registerModule(durakModule).registerModule(codenamesModule).registerModule(unoModule).register(mafiaDefinition);
  if (enableTestGame) registry.registerModule(sandboxModule);
  return registry;
}
