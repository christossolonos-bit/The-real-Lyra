// Body fidgets stub — full Rocketbox body engine lives in the-student; sleep only needs playMoves.
import { bus } from './events.js';

export function playMoves(names = []) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  if (list.length) bus.emit('avatar-body', { moves: list });
  return list;
}

export function startBody() {}
export function stopBody() {}
