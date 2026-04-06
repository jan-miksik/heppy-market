import { eq } from 'drizzle-orm';
import { InitiaLinkRequestSchema, InitiaSyncRequestSchema } from '@something-in-loop/shared';
import { agents } from '../../db/schema.js';
import { nowIso } from '../../lib/utils.js';
import { validateBody } from '../../lib/validation.js';
import { formatAgent, normalizeInitiaWalletAddress, parseInitiaSyncState, withOwnedAgent } from './shared.js';
import type { AgentsRoute } from './shared.js';

export function registerAgentInitiaRoutes(agentsRoute: AgentsRoute): void {
  /** POST /api/agents/:id/initia/link — attach onchain link metadata */
  agentsRoute.post('/:id/initia/link', async (c) => {
    const body = await validateBody(c, InitiaLinkRequestSchema);

    return withOwnedAgent(c, async ({ id, db, agent: existing }) => {
      if (existing.chain !== 'initia') {
        return c.json({ error: 'Initia link is only supported for Initia agents.' }, 400);
      }

      const initiaWalletAddress = normalizeInitiaWalletAddress(body.initiaWalletAddress);
      if (!initiaWalletAddress) {
        return c.json({ error: 'Invalid Initia wallet address.' }, 400);
      }

      const now = nowIso();
      const currentSync = parseInitiaSyncState(existing.initiaSyncState);
      const mergedSync = {
        ...currentSync,
        walletAddress: initiaWalletAddress,
        evmAddress: body.evmAddress ?? currentSync.evmAddress ?? null,
        linkTxHash: body.txHash,
        metadataPointer: body.metadataPointer,
      };

      await db
        .update(agents)
        .set({
          initiaWalletAddress,
          initiaMetadataHash: body.metadataPointer.configHash,
          initiaMetadataVersion: body.metadataPointer.version,
          initiaLinkTxHash: body.txHash,
          initiaLinkedAt: now,
          initiaSyncState: JSON.stringify(mergedSync),
          initiaLastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(agents.id, id));

      const [updated] = await db.select().from(agents).where(eq(agents.id, id));
      return c.json(formatAgent(updated));
    });
  });

  /** POST /api/agents/:id/initia/sync — persist latest wallet/onchain snapshot */
  agentsRoute.post('/:id/initia/sync', async (c) => {
    const body = await validateBody(c, InitiaSyncRequestSchema);

    return withOwnedAgent(c, async ({ id, db, agent: existing }) => {
      if (existing.chain !== 'initia') {
        return c.json({ error: 'Initia sync is only supported for Initia agents.' }, 400);
      }

      const normalizedWalletAddress = normalizeInitiaWalletAddress(body.state.walletAddress);
      const now = nowIso();
      const currentSync = parseInitiaSyncState(existing.initiaSyncState);
      const mergedSync = {
        ...currentSync,
        ...body.state,
        ...(normalizedWalletAddress ? { walletAddress: normalizedWalletAddress } : {}),
      };

      const updates: Partial<typeof agents.$inferInsert> = {
        initiaSyncState: JSON.stringify(mergedSync),
        initiaLastSyncedAt: now,
        updatedAt: now,
      };
      if (normalizedWalletAddress) updates.initiaWalletAddress = normalizedWalletAddress;

      await db.update(agents).set(updates).where(eq(agents.id, id));
      return c.json({ ok: true, state: mergedSync, syncedAt: now });
    });
  });

  /** GET /api/agents/:id/initia/status */
  agentsRoute.get('/:id/initia/status', async (c) => {
    return withOwnedAgent(c, async ({ agent: existing }) => {
      if (existing.chain !== 'initia') {
        return c.json({ error: 'Initia status is only available for Initia agents.' }, 400);
      }

      const state = parseInitiaSyncState(existing.initiaSyncState);
      return c.json({
        agentId: existing.id,
        chain: existing.chain,
        initiaWalletAddress: existing.initiaWalletAddress,
        metadataHash: existing.initiaMetadataHash,
        metadataVersion: existing.initiaMetadataVersion,
        linkTxHash: existing.initiaLinkTxHash,
        linkedAt: existing.initiaLinkedAt,
        lastSyncedAt: existing.initiaLastSyncedAt,
        state,
      });
    });
  });
}
