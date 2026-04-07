export type SpotPositionState = 'FLAT' | 'LONG';
export type SpotAction = 'OPEN_LONG' | 'CLOSE_LONG' | 'HOLD';

/**
 * Returns true if the action is legal given the current position state.
 */
export function isLegalAction(current: SpotPositionState, action: SpotAction): boolean {
  if (action === 'HOLD') return true;
  if (action === 'OPEN_LONG') return current === 'FLAT';
  if (action === 'CLOSE_LONG') return current === 'LONG';
  return false;
}

/**
 * Returns the next state given current state and action.
 * Throws if the transition is illegal.
 */
export function nextState(current: SpotPositionState, action: SpotAction): SpotPositionState {
  if (!isLegalAction(current, action)) {
    throw new Error(`Illegal spot transition: ${current} + ${action}`);
  }
  if (action === 'OPEN_LONG') return 'LONG';
  if (action === 'CLOSE_LONG') return 'FLAT';
  return current;
}
