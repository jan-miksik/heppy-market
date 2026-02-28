<script setup lang="ts">
import type { ProfileItem } from '~/composables/useProfiles';

const props = defineProps<{
  profile: ProfileItem;
  selected?: boolean;
}>();

const emit = defineEmits<{ select: [profile: ProfileItem] }>();
</script>

<template>
  <div
    class="pcard"
    :class="{ 'pcard--selected': selected }"
    @click="emit('select', profile)"
  >
    <div class="pcard__emoji">{{ profile.emoji }}</div>
    <div class="pcard__name">{{ profile.name }}</div>
    <div class="pcard__desc">{{ profile.description }}</div>
    <div v-if="selected" class="pcard__check">✓</div>
  </div>
</template>

<style scoped>
.pcard {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  padding: 14px 10px 12px;
  width: 140px;
  min-height: 110px;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s, transform 0.1s;
  background: var(--surface, #141414);
  flex-shrink: 0;
  text-align: center;
}
.pcard:hover {
  border-color: var(--accent, #7c6af7);
  background: color-mix(in srgb, var(--accent, #7c6af7) 6%, var(--surface, #141414));
  transform: translateY(-1px);
}
.pcard--selected {
  border-color: var(--accent, #7c6af7);
  background: color-mix(in srgb, var(--accent, #7c6af7) 12%, var(--surface, #141414));
  box-shadow: 0 0 0 1px var(--accent, #7c6af7), 0 4px 16px color-mix(in srgb, var(--accent, #7c6af7) 20%, transparent);
}
.pcard__emoji {
  font-size: 26px;
  line-height: 1;
  flex-shrink: 0;
}
.pcard__name {
  font-size: 11px;
  font-weight: 700;
  color: var(--text, #e0e0e0);
  line-height: 1.2;
  letter-spacing: 0.01em;
}
.pcard--selected .pcard__name {
  color: var(--accent, #7c6af7);
}
.pcard__desc {
  font-size: 10px;
  color: var(--text-muted, #555);
  line-height: 1.35;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pcard--selected .pcard__desc {
  color: color-mix(in srgb, var(--accent, #7c6af7) 70%, var(--text-muted, #555));
}
.pcard__check {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 11px;
  color: var(--accent, #7c6af7);
  font-weight: 700;
}
</style>
