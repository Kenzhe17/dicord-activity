import { Card, CardSuit, CardRank, DurakGameState, DurakMode } from '@rize3-arcade/shared';

export class DurakGame {
  private static SUITS: CardSuit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
  private static RANKS: CardRank[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  static createDeck(): Card[] {
    const deck: Card[] = [];
    for (const suit of this.SUITS) {
      for (const rank of this.RANKS) {
        deck.push({
          suit,
          rank,
          id: `${suit}-${rank}`,
        });
      }
    }
    return this.shuffle(deck);
  }

  private static shuffle(array: Card[]): Card[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  static initializeGame(playerIds: string[], mode: DurakMode = 'podkidnoy'): DurakGameState {
    const deck = this.createDeck();
    const trumpCard = deck.pop() || null;
    const trumpSuit = trumpCard?.suit || null;

    // Deal 6 cards to each player
    const cardsPerPlayer = 6;
    const playersCards: Record<string, Card[]> = {};
    
    for (const playerId of playerIds) {
      playersCards[playerId] = deck.splice(0, cardsPerPlayer);
    }

    return {
      deck,
      table: [],
      trumpCard,
      trumpSuit,
      currentTurn: playerIds[0], // First player starts
      attacker: playerIds[0],
      defender: playerIds[1] || null,
      gamePhase: 'waiting',
      winner: null,
    };
  }

  static canPlayCard(card: Card, gameState: DurakGameState, playerId: string): boolean {
    if (gameState.gamePhase === 'finished') return false;
    if (gameState.currentTurn !== playerId) return false;

    const table = gameState.table;
    if (table.length === 0) {
      // First card can be any card
      return true;
    }

    const topCard = table[table.length - 1];
    
    // Can play same suit or same rank
    if (card.suit === topCard.suit) return true;
    if (card.rank === topCard.rank) return true;

    // Can play trump if needed
    if (gameState.trumpSuit && card.suit === gameState.trumpSuit) {
      return true;
    }

    return false;
  }

  static playCard(card: Card, gameState: DurakGameState, playerId: string): DurakGameState {
    if (!this.canPlayCard(card, gameState, playerId)) {
      return gameState;
    }

    const newTable = [...gameState.table, card];
    const newDeck = gameState.deck.filter(c => c.id !== card.id);

    return {
      ...gameState,
      table: newTable,
      deck: newDeck,
    };
  }

  static calculateWinner(gameState: DurakGameState, playerIds: string[]): string | null {
    // Simple logic: player with no cards loses, other wins
    // This is a simplified version - real Durak is more complex
    const playerHandSizes = playerIds.map(id => {
      const handSize = 6 - gameState.table.filter(c => 
        gameState.deck.some(d => d.id === c.id)
      ).length;
      return { id, handSize };
    });

    // In real Durak, winner is determined by gameplay
    // For now, return the first player as winner
    return playerIds[0] || null;
  }
}
