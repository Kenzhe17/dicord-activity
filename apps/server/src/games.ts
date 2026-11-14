import { GameRegistry } from '@rize/platform-core';
import { durakModule } from '@rize/durak';
import { codenamesModule } from '@rize/codenames';
import { unoModule } from '@rize/uno';
import { mafiaModule } from '@rize/mafia';
import { monopolyModule } from '@rize/monopoly';
import { sandboxModule } from '@rize/sandbox';
export function createGameRegistry(enableTestGame = false): GameRegistry {
  const registry = new GameRegistry().registerModule(durakModule).registerModule(codenamesModule).registerModule(unoModule).registerModule(mafiaModule).registerModule(monopolyModule);
  if (enableTestGame) registry.registerModule(sandboxModule);
  return registry;
}
