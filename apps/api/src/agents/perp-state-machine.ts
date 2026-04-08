export type PerpPositionState = 'FLAT' | 'LONG' | 'SHORT';
export type PerpAction = 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT' | 'HOLD';

/**
 * Returns true if the action is legal given the current position state.
 */
export function isLegalAction(current: PerpPositionState, action: PerpAction): boolean {
  if (action === 'HOLD') return true;
  if (action === 'OPEN_LONG') return current === 'FLAT';
  if (action === 'OPEN_SHORT') return current === 'FLAT';
  if (action === 'CLOSE_LONG') return current === 'LONG';
  if (action === 'CLOSE_SHORT') return current === 'SHORT';
  return false;
}

/**
 * Returns the next state given current state and action.
 * Throws if the transition is illegal.
 */
export function nextState(current: PerpPositionState, action: PerpAction): PerpPositionState {
  if (!isLegalAction(current, action)) {
    throw new Error(`Illegal perp transition: ${current} + ${action}`);
  }
  if (action === 'OPEN_LONG') return 'LONG';
  if (action === 'OPEN_SHORT') return 'SHORT';
  if (action === 'CLOSE_LONG') return 'FLAT';
  if (action === 'CLOSE_SHORT') return 'FLAT';
  return current;
}
