import { getAgentPersonaTemplate, getDefaultAgentPersona } from '@something-in-loop/shared';

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Resolve the persona markdown that should be sent to the LLM.
 *
 * Sources (highest precedence first):
 * 1) `agents.personaMd` column (explicit custom persona)
 * 2) `config.personaMd` in the JSON blob (legacy / create-time storage)
 * 3) Profile template from `agents.profileId` or `config.profileId`
 * 4) Default persona (uses agent name as header)
 */
export function resolveAgentPersonaMd(args: {
  agentName: string;
  agentPersonaMd: string | null | undefined;
  agentProfileId: string | null | undefined;
  config: Record<string, unknown>;
}): string {
  const { agentName, agentPersonaMd, agentProfileId, config } = args;

  const configPersonaMd = (config as any).personaMd;
  if (nonEmptyString(agentPersonaMd)) return agentPersonaMd.trim();
  if (nonEmptyString(configPersonaMd)) return configPersonaMd.trim();

  const profileId = agentProfileId ?? ((config as any).profileId as unknown);
  if (nonEmptyString(profileId)) return getAgentPersonaTemplate(profileId, agentName);

  return getDefaultAgentPersona(agentName);
}

