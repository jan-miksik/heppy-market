import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Env } from '../../types/env.js';
import { agentDecisions, users } from '../../db/schema.js';
import { resolveStoredOpenRouterKey } from '../../lib/openrouter-key.js';
import { generateId, nowIso } from '../../lib/utils.js';
import type { CachedAgentRow } from '../trading-agent.js';
import type { MarketDataItem } from './types.js';

export type ResolvedLlmCredentials = {
  llmApiKey: string;
  llmProvider: 'openrouter' | 'anthropic';
};

type ResolveLlmCredentialsParams = {
  env: Env;
  db: ReturnType<typeof drizzle>;
  agentId: string;
  agentRow: Pick<CachedAgentRow, 'ownerAddress'>;
  effectiveLlmModel: string;
  marketData: MarketDataItem[];
};

async function insertHoldDecision(
  db: ReturnType<typeof drizzle>,
  params: {
    agentId: string;
    effectiveLlmModel: string;
    marketData: MarketDataItem[];
    reasoning: string;
  },
): Promise<void> {
  await db.insert(agentDecisions).values({
    id: generateId('dec'),
    agentId: params.agentId,
    decision: 'hold',
    confidence: 0,
    reasoning: params.reasoning,
    llmModel: params.effectiveLlmModel,
    llmLatencyMs: 0,
    marketDataSnapshot: JSON.stringify(params.marketData),
    createdAt: nowIso(),
  });
}

export async function resolveLlmCredentials(params: ResolveLlmCredentialsParams): Promise<ResolvedLlmCredentials | null> {
  const { env, db, agentId, agentRow, effectiveLlmModel, marketData } = params;
  const isAnthropicModel = effectiveLlmModel.startsWith('claude-');
  console.log(
    `[agent-loop] ${agentId}: LLM routing - model=${effectiveLlmModel} isAnthropic=${isAnthropicModel} hasAnthropicKey=${!!env.ANTHROPIC_API_KEY}`,
  );

  if (isAnthropicModel) {
    if (!env.ANTHROPIC_API_KEY) {
      console.error(`[agent-loop] ${agentId}: ANTHROPIC_API_KEY is not set. Cannot use Claude model.`);
      await insertHoldDecision(db, {
        agentId,
        effectiveLlmModel,
        marketData,
        reasoning: 'ANTHROPIC_API_KEY is not configured. Add it to .dev.vars (local) or Cloudflare secrets (production).',
      });
      return null;
    }

    const ownerAddress = agentRow.ownerAddress?.toLowerCase();
    if (ownerAddress) {
      const [ownerUser] = await db.select({ role: users.role }).from(users).where(eq(users.walletAddress, ownerAddress));
      if (ownerUser?.role !== 'tester') {
        console.warn(`[agent-loop] ${agentId}: owner ${ownerAddress} is not a tester. Anthropic models restricted.`);
        await insertHoldDecision(db, {
          agentId,
          effectiveLlmModel,
          marketData,
          reasoning: 'Claude models are restricted to tester accounts. Contact the admin to enable access.',
        });
        return null;
      }
    }

    return {
      llmApiKey: env.ANTHROPIC_API_KEY,
      llmProvider: 'anthropic',
    };
  }

  if (!env.OPENROUTER_API_KEY) {
    console.error(
      `[agent-loop] ${agentId}: OPENROUTER_API_KEY is not set. Cannot call LLM. Add it to .dev.vars (local) or Cloudflare secrets (production).`,
    );
    await insertHoldDecision(db, {
      agentId,
      effectiveLlmModel,
      marketData,
      reasoning:
        'OPENROUTER_API_KEY is not configured. Please set it in .dev.vars (local) or Cloudflare secrets (production) - get a free key at openrouter.ai',
    });
    return null;
  }

  let resolvedKey = env.OPENROUTER_API_KEY;
  const ownerAddr = agentRow.ownerAddress?.toLowerCase();
  if (ownerAddr) {
    const [ownerUser] = await db.select({ id: users.id, openRouterKey: users.openRouterKey }).from(users).where(eq(users.walletAddress, ownerAddr));
    if (ownerUser?.openRouterKey) {
      const resolved = await resolveStoredOpenRouterKey({
        storedKey: ownerUser.openRouterKey,
        serverKey: env.OPENROUTER_API_KEY,
        encryptionSecret: env.KEY_ENCRYPTION_SECRET,
        logPrefix: `[agent-loop] ${agentId}:`,
        persistEncrypted: async (encryptedKey) => {
          await db
            .update(users)
            .set({ openRouterKey: encryptedKey, updatedAt: nowIso() })
            .where(eq(users.id, ownerUser.id));
        },
      });
      resolvedKey = resolved.apiKey;
    }
  }

  return {
    llmApiKey: resolvedKey,
    llmProvider: 'openrouter',
  };
}
