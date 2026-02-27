<script setup lang="ts">
import type { ProfileItem } from '~/composables/useProfiles';

const props = defineProps<{
  profile: ProfileItem;
  selected?: boolean;
}>();

const emit = defineEmits<{ select: [profile: ProfileItem] }>();

const keyTraits = computed(() => {
  const b = props.profile.behaviorConfig;
  const traits: string[] = [];
  if (b.riskAppetite) traits.push(String(b.riskAppetite));
  if (b.style) traits.push(String(b.style));
  if (b.decisionSpeed) traits.push(String(b.decisionSpeed));
  return traits.slice(0, 3);
});
</script>

<template>
  <div
    class="profile-card"
    :class="{ 'profile-card--selected': selected }"
    @click="emit('select', profile)"
  >
    <div class="profile-card__emoji">{{ profile.emoji }}</div>
    <div class="profile-card__body">
      <div class="profile-card__name">{{ profile.name }}</div>
      <div class="profile-card__desc">{{ profile.description }}</div>
      <div class="profile-card__traits">
        <span v-for="trait in keyTraits" :key="trait" class="profile-card__trait">{{ trait }}</span>
      </div>
    </div>
    <div v-if="selected" class="profile-card__check">✓</div>
  </div>
</template>

<style scoped>
.profile-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  background: var(--card-bg, #111);
  position: relative;
}
.profile-card:hover { border-color: var(--accent, #7c6af7); }
.profile-card--selected { border-color: var(--accent, #7c6af7); background: color-mix(in srgb, var(--accent, #7c6af7) 10%, transparent); }
.profile-card__emoji { font-size: 28px; flex-shrink: 0; }
.profile-card__body { flex: 1; min-width: 0; }
.profile-card__name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.profile-card__desc { font-size: 12px; color: var(--text-secondary, #888); line-height: 1.4; }
.profile-card__traits { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.profile-card__trait { background: var(--tag-bg, #1e1e1e); border: 1px solid var(--border, #2a2a2a); border-radius: 4px; padding: 2px 6px; font-size: 11px; color: var(--text-secondary, #888); text-transform: capitalize; }
.profile-card__check { color: var(--accent, #7c6af7); font-weight: 700; font-size: 18px; flex-shrink: 0; }
</style>
