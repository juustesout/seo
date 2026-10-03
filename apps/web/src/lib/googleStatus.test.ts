import { describe, expect, it } from 'vitest';
import { googleProductState } from './googleStatus';

describe('googleProductState', () => {
  it('is not connected when the account has not authorized Google', () => {
    expect(googleProductState({ google: { connected: false, error: null }, current: null })).toBe('not_connected');
  });

  it('needs attention when the account is connected but reports an error', () => {
    expect(googleProductState({ google: { connected: true, error: 'boom' }, current: null })).toBe('needs_attention');
  });

  it('needs configuration when connected but the project has no binding', () => {
    expect(googleProductState({ google: { connected: true, error: null }, current: null })).toBe('needs_configuration');
  });

  it('is connected when the account is connected and the project is bound', () => {
    expect(googleProductState({ google: { connected: true, error: null }, current: { id: '1' } })).toBe('connected');
  });
});
