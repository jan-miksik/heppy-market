import { describe, expect, it } from 'vitest';
import {
  AGENT_PAID_MODEL_ITEMS,
  FREE_MODEL_ITEMS,
  type ModelCatalogItem,
} from '@something-in-loop/shared';
import { deriveModelPickerState, resolveHydratedLlmModel } from '../utils/llm-models';

describe('resolveHydratedLlmModel', () => {
  const freeCatalog = [...FREE_MODEL_ITEMS] as ModelCatalogItem[];
  const fullCatalog = [...FREE_MODEL_ITEMS, ...AGENT_PAID_MODEL_ITEMS] as ModelCatalogItem[];

  it('falls back to the default free model when a disconnected user has a saved paid model', () => {
    expect(resolveHydratedLlmModel({
      savedModel: AGENT_PAID_MODEL_ITEMS[0]?.id,
      catalog: freeCatalog,
      hasOwnKey: false,
    })).toBe(FREE_MODEL_ITEMS[0]?.id);
  });

  it('keeps a saved free model when a disconnected user has no OpenRouter key', () => {
    expect(resolveHydratedLlmModel({
      savedModel: FREE_MODEL_ITEMS[1]?.id,
      catalog: freeCatalog,
      hasOwnKey: false,
    })).toBe(FREE_MODEL_ITEMS[1]?.id);
  });

  it('keeps a saved custom free model when a disconnected user selected one earlier', () => {
    expect(resolveHydratedLlmModel({
      savedModel: 'meta-llama/llama-4-free:free',
      catalog: freeCatalog,
      hasOwnKey: false,
    })).toBe('meta-llama/llama-4-free:free');
  });

  it('keeps a saved paid model when the user still has OpenRouter connected', () => {
    expect(resolveHydratedLlmModel({
      savedModel: AGENT_PAID_MODEL_ITEMS[0]?.id,
      catalog: fullCatalog,
      hasOwnKey: true,
    })).toBe(AGENT_PAID_MODEL_ITEMS[0]?.id);
  });
});

describe('deriveModelPickerState', () => {
  const catalog = [...FREE_MODEL_ITEMS] as ModelCatalogItem[];

  it('uses dropdown selection for catalog models', () => {
    expect(deriveModelPickerState({
      value: FREE_MODEL_ITEMS[1]?.id ?? '',
      catalog,
    })).toEqual({
      dropdownModel: FREE_MODEL_ITEMS[1]?.id,
      customModel: '',
    });
  });

  it('preserves unavailable models as custom values instead of coercing them', () => {
    expect(deriveModelPickerState({
      value: AGENT_PAID_MODEL_ITEMS[0]?.id ?? '',
      catalog,
    })).toEqual({
      dropdownModel: FREE_MODEL_ITEMS[0]?.id,
      customModel: AGENT_PAID_MODEL_ITEMS[0]?.id,
    });
  });
});
