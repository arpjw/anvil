import { describe, expect, test } from 'bun:test';
import {
  InvalidTransitionError,
  canTransition,
  isTerminal,
  transition,
} from '../state/machine';
import type { SessionStatus } from '../db/schema';

const validPairs: Array<[SessionStatus, SessionStatus]> = [
  ['queued', 'provisioning'],
  ['queued', 'failed'],
  ['queued', 'aborted'],
  ['provisioning', 'running'],
  ['provisioning', 'failed'],
  ['provisioning', 'aborted'],
  ['running', 'reviewing'],
  ['running', 'complete'],
  ['running', 'failed'],
  ['running', 'aborted'],
  ['reviewing', 'running'],
  ['reviewing', 'failed'],
  ['reviewing', 'aborted'],
  ['complete', 'complete'],
  ['failed', 'failed'],
  ['aborted', 'aborted'],
];

const invalidPairs: Array<[SessionStatus, SessionStatus]> = [
  ['queued', 'running'],
  ['queued', 'reviewing'],
  ['queued', 'complete'],
  ['running', 'queued'],
  ['running', 'provisioning'],
  ['complete', 'running'],
  ['failed', 'running'],
  ['aborted', 'running'],
  ['reviewing', 'complete'],
];

describe('state machine', () => {
  test('all valid transitions succeed', () => {
    for (const [from, to] of validPairs) {
      expect(transition(from, to)).toBe(to);
      expect(canTransition(from, to)).toBe(true);
    }
  });

  test('queued → complete throws InvalidTransitionError', () => {
    expect(() => transition('queued', 'complete')).toThrow(InvalidTransitionError);
  });

  test('running → queued throws InvalidTransitionError', () => {
    expect(() => transition('running', 'queued')).toThrow(InvalidTransitionError);
  });

  test('complete → running throws InvalidTransitionError', () => {
    expect(() => transition('complete', 'running')).toThrow(InvalidTransitionError);
  });

  test('invalid pairs all throw', () => {
    for (const [from, to] of invalidPairs) {
      expect(() => transition(from, to)).toThrow(InvalidTransitionError);
      expect(canTransition(from, to)).toBe(false);
    }
  });

  test('InvalidTransitionError is an HttpError 400', () => {
    try {
      transition('queued', 'running');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.status).toBe(400);
      expect(e.code).toBe('invalid_transition');
      expect(e.message).toContain('queued');
      expect(e.message).toContain('running');
    }
  });

  test('isTerminal: true for complete, failed, aborted', () => {
    expect(isTerminal('complete')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('aborted')).toBe(true);
  });

  test('isTerminal: false for queued, provisioning, running, reviewing', () => {
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('provisioning')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('reviewing')).toBe(false);
  });
});
