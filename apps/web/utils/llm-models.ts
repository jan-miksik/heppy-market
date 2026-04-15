import { DEFAULT_FREE_AGENT_MODEL } from '@something-in-loop/shared';
import type { ModelCatalogItem } from '@something-in-loop/shared';

export function isCatalogModel(id: string, catalog: ModelCatalogItem[]): boolean {
  return catalog.some((item) => item.id === id);
}

export function resolveHydratedLlmModel(params: {
  savedModel: string | null | undefined;
  catalog: ModelCatalogItem[];
  hasOwnKey: boolean;
  fallback?: string;
}): string {
  const fallback = params.fallback ?? DEFAULT_FREE_AGENT_MODEL;
  const savedModel = params.savedModel?.trim();

  if (!savedModel) return fallback;
  if (isCatalogModel(savedModel, params.catalog)) return savedModel;
  if (params.hasOwnKey) return savedModel;
  if (savedModel.endsWith(':free')) return savedModel;
  return fallback;
}

export function deriveModelPickerState(params: {
  value: string;
  catalog: ModelCatalogItem[];
}): { dropdownModel: string; customModel: string } {
  const { value, catalog } = params;
  if (isCatalogModel(value, catalog)) {
    return {
      dropdownModel: value,
      customModel: '',
    };
  }

  return {
    dropdownModel: catalog[0]?.id ?? value,
    customModel: value,
  };
}
