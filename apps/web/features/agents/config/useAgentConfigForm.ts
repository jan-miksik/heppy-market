import { ref, reactive, computed, watch, onMounted } from 'vue';
import {
  AGENT_PAID_MODEL_ITEMS,
  DEFAULT_FREE_AGENT_MODEL,
  ENTITY_NAME_MAX_CHARS,
  buildAgentModelCatalog,
  getAgentPersonaTemplate,
  resolveAgentProfileId,
} from '@something-in-loop/shared';
import type { CreateAgentPayload } from '~/composables/useAgents';
import { useAgents } from '~/composables/useAgents';
import type { ProfileItem } from '~/composables/useProfiles';

export function useAgentConfigForm(props: {
  initialValues?: Partial<CreateAgentPayload & { pairs: string[] }>;
}) {
  const { user } = useAuth();
  const { initConnect } = useOpenRouter();
  const route = useRoute();

  const { getAgent } = useAgents();
  const isEditing = computed(() => !!props.initialValues);
  const loadingFrom = ref(false);
  const isTester = computed(() => user.value?.role === 'tester');
  const hasOwnKey = computed(() => !!user.value?.openRouterKeySet);
  const openRouterRedirecting = ref(false);

  const modelCatalog = computed(() => {
    return buildAgentModelCatalog({
      hasOwnOpenRouterKey: hasOwnKey.value,
      isTester: isTester.value,
    });
  });

  const form = reactive<CreateAgentPayload & { pairs: string[] }>({
    name: '',
    pairs: ['INIT/USD'],
    paperBalance: 1000,
    strategies: ['combined'],
    analysisInterval: '1h',
    maxPositionSizePct: 2,
    stopLossPct: 2,
    takeProfitPct: 3,
    maxOpenPositions: 3,
    llmModel: DEFAULT_FREE_AGENT_MODEL,
    allowFallback: false,
    temperature: 0.7,
  });

  const submitting = ref(false);
  const validationError = ref('');
  const initialSubmitPayload = ref<CreateAgentPayload | null>(null);

  // Behavior & Persona
  const selectedProfileId = ref<string | null>(null);
  const selectedProfileName = ref('');
  const selectedProfileDescription = ref('');
  const isPersonaCustomized = ref(false);
  const personaMd = ref('');
  const behavior = ref<Record<string, unknown>>({
    riskAppetite: 'moderate',
    fomoProne: 30,
    panicSellThreshold: 50,
    contrarian: 20,
    analysisDepth: 'balanced',
    decisionSpeed: 'measured',
    confidenceThreshold: 60,
    overthinker: false,
    style: 'swing',
    preferredConditions: 'any',
    entryPreference: 'momentum',
    exitStrategy: 'signal_based',
    averageDown: false,
    verbosity: 'normal',
    personality: 'professional',
    emotionalAwareness: false,
    defaultBias: 'neutral',
    adaptability: 50,
    memoryWeight: 'medium',
  });

  const behaviorMd = ref('');
  const isBehaviorCustomized = ref(false);
  const roleMd = ref('');
  const isRoleCustomized = ref(false);

  // Accordions
  const configOpen = ref(false);
  const finetuneOpen = ref(false);
  const personaMdOpen = ref(false);

  const AVAILABLE_PAIRS = ['INIT/USD', 'WETH/USDC', 'cbBTC/USDC', 'AERO/WETH'] as const;

  function shortModelName(m: string): string {
    const PAID_MODEL_NAMES = Object.fromEntries(AGENT_PAID_MODEL_ITEMS.map((p) => [p.id, p.label]));
    const n: Record<string, string> = {
      [DEFAULT_FREE_AGENT_MODEL]: 'Nemotron-120B',
      'qwen/qwen3-coder:free': 'Qwen3-Coder',
      'nvidia/nemotron-nano-9b-v2:free': 'Nemotron-9B',
      'arcee-ai/trinity-large-preview:free': 'Trinity-Large',
      'minimax/minimax-m2.5': 'MiniMax M2.5',
      'mistralai/mistral-small-2603': 'Mistral Small',
      'claude-sonnet-4-5': 'Claude Sonnet',
      'claude-haiku-4-5': 'Claude Haiku',
      ...PAID_MODEL_NAMES,
    };
    return n[m] ?? m.split('/').pop()?.split(':')[0] ?? 'Agent';
  }

  function generateName(): string {
    const model = shortModelName(form.llmModel ?? DEFAULT_FREE_AGENT_MODEL);
    const pair = form.pairs.length === 1 ? form.pairs[0] : form.pairs.length > 1 ? `${form.pairs[0]} +${form.pairs.length - 1}` : 'Base';
    const style = isPersonaCustomized.value ? 'Custom' : selectedProfileName.value || '';
    return style ? `${model} · ${pair} · ${style}` : `${model} · ${pair}`;
  }

  const syncNameWithModel = ref(true);

  function generatePersonaMd() {
    if (!selectedProfileId.value) return;
    personaMd.value = getAgentPersonaTemplate(selectedProfileId.value, form.name || 'Agent');
  }

  // Watches
  watch([() => form.llmModel, () => [...form.pairs], isPersonaCustomized, selectedProfileName], () => {
    if (syncNameWithModel.value) form.name = generateName();
  });

  watch(() => form.name, (name) => {
    if (!isPersonaCustomized.value && selectedProfileId.value && personaMd.value) {
      const newPersona = getAgentPersonaTemplate(selectedProfileId.value, name || 'Agent');
      const existingLines = personaMd.value.split('\n');
      const firstLine = newPersona.split('\n')[0] ?? '';
      if (existingLines[0] !== firstLine) {
        existingLines[0] = firstLine;
        personaMd.value = existingLines.join('\n');
      }
    }
  });

  watch(behavior, () => {
    if (!isPersonaCustomized.value && selectedProfileId.value) {
      generatePersonaMd();
    }
  }, { deep: true });

  // Methods
  function onProfileSelected(profile: ProfileItem) {
    selectedProfileId.value = profile.id;
    selectedProfileName.value = profile.name;
    selectedProfileDescription.value = profile.description;
    behavior.value = { ...profile.behaviorConfig };
    isPersonaCustomized.value = false;
    generatePersonaMd();
    if (syncNameWithModel.value) form.name = generateName();
  }

  function onPersonaEdited() {
    isPersonaCustomized.value = true;
    if (syncNameWithModel.value) form.name = generateName();
  }

  function restorePersona() {
    isPersonaCustomized.value = false;
    generatePersonaMd();
    if (syncNameWithModel.value) form.name = generateName();
  }

  function restoreBehavior() {
    behaviorMd.value = '';
    isBehaviorCustomized.value = false;
  }

  function togglePair(p: string) {
    form.pairs = form.pairs.includes(p) ? form.pairs.filter((x) => x !== p) : [...form.pairs, p];
  }

  function buildSubmitPayload(): CreateAgentPayload {
    return {
      ...form,
      llmModel: form.llmModel ?? DEFAULT_FREE_AGENT_MODEL,
      allowFallback: form.allowFallback ?? false,
      behavior: behavior.value,
      profileId: selectedProfileId.value ?? undefined,
      personaMd: personaMd.value || undefined,
      behaviorMd: behaviorMd.value || undefined,
      roleMd: roleMd.value || undefined,
    } as CreateAgentPayload;
  }

  function handleConnectOpenRouter() {
    openRouterRedirecting.value = true;
    initConnect({ returnTo: route.fullPath || '/agents/create' }).catch(() => {
      openRouterRedirecting.value = false;
    });
  }

  onMounted(() => {
    if (props.initialValues) {
      Object.assign(form, props.initialValues);
      const allowed = new Set<string>(AVAILABLE_PAIRS);
      form.pairs = form.pairs.filter((p) => allowed.has(p));
      if (form.pairs.length === 0) form.pairs = [AVAILABLE_PAIRS[0]];

      const clamp = (n: unknown, min: number, max: number, fallback: number) => {
        const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
        return Math.min(max, Math.max(min, v));
      };
      form.paperBalance = clamp(form.paperBalance, 100, 1_000_000, 10_000);
      form.maxPositionSizePct = clamp(form.maxPositionSizePct, 1, 100, 5);
      form.stopLossPct = clamp(form.stopLossPct, 0.5, 50, 5);
      form.takeProfitPct = clamp(form.takeProfitPct, 0.5, 100, 7);
      form.maxOpenPositions = clamp(form.maxOpenPositions, 1, 10, 3);
      form.temperature = clamp(form.temperature, 0, 2, 0.7);

      if (props.initialValues.behavior) behavior.value = props.initialValues.behavior as Record<string, unknown>;
      if (props.initialValues.profileId) {
        selectedProfileId.value = resolveAgentProfileId(props.initialValues.profileId);
      }
      if (props.initialValues.personaMd) {
        personaMd.value = props.initialValues.personaMd;
        isPersonaCustomized.value = true;
      } else if (props.initialValues.profileId) {
        generatePersonaMd();
      }
      if (props.initialValues.behaviorMd) {
        behaviorMd.value = props.initialValues.behaviorMd;
        isBehaviorCustomized.value = true;
      }
      if ((props.initialValues as any).roleMd) {
        roleMd.value = (props.initialValues as any).roleMd;
        isRoleCustomized.value = true;
      }
      initialSubmitPayload.value = buildSubmitPayload();
    } else if (route.query.from) {
      // Pre-fill from a paper agent (Go Live flow)
      loadingFrom.value = true;
      getAgent(String(route.query.from))
        .then((sourceAgent) => {
          const cfg = sourceAgent.config ?? {};
          const allowed = new Set<string>(AVAILABLE_PAIRS);

          Object.assign(form, {
            name: sourceAgent.name,
            llmModel: sourceAgent.llmModel ?? DEFAULT_FREE_AGENT_MODEL,
            pairs: ((cfg.pairs as string[]) ?? ['INIT/USD']).filter((p) => allowed.has(p)),
            paperBalance: cfg.paperBalance ?? 10_000,
            strategies: cfg.strategies ?? ['combined'],
            analysisInterval: cfg.analysisInterval ?? '1h',
            maxPositionSizePct: cfg.maxPositionSizePct ?? 5,
            stopLossPct: cfg.stopLossPct ?? 5,
            takeProfitPct: cfg.takeProfitPct ?? 7,
            maxOpenPositions: cfg.maxOpenPositions ?? 3,
            temperature: cfg.temperature ?? 0.7,
            allowFallback: cfg.allowFallback ?? false,
          });

          if (form.pairs.length === 0) form.pairs = [AVAILABLE_PAIRS[0]];

          if (cfg.behavior) behavior.value = cfg.behavior as Record<string, unknown>;
          if (sourceAgent.profileId) {
            selectedProfileId.value = resolveAgentProfileId(sourceAgent.profileId);
          }
          if (sourceAgent.personaMd) {
            personaMd.value = sourceAgent.personaMd;
            isPersonaCustomized.value = true;
          } else if (selectedProfileId.value) {
            generatePersonaMd();
          }

          syncNameWithModel.value = false;
        })
        .catch(() => {
          form.name = generateName();
        })
        .finally(() => {
          loadingFrom.value = false;
        });
    } else {
      form.name = generateName();
    }
  });

  return {
    form,
    loadingFrom,
    behavior,
    personaMd,
    behaviorMd,
    roleMd,
    selectedProfileId,
    selectedProfileName,
    selectedProfileDescription,
    isPersonaCustomized,
    isBehaviorCustomized,
    isRoleCustomized,
    isEditing,
    hasOwnKey,
    modelCatalog,
    openRouterRedirecting,
    syncNameWithModel,
    submitting,
    validationError,
    configOpen,
    finetuneOpen,
    personaMdOpen,
    AVAILABLE_PAIRS,
    onProfileSelected,
    onPersonaEdited,
    restorePersona,
    restoreBehavior,
    togglePair,
    buildSubmitPayload,
    handleConnectOpenRouter,
    initialSubmitPayload,
  };
}
