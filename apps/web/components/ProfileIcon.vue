<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    profileId: string;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 32,
    strokeWidth: 1.5,
  },
);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    fill="none"
    :stroke-width="strokeWidth"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="picon"
    :data-profile="profileId"
  >
    <!-- The Professor — mortarboard + tassel -->
    <g v-if="profileId === 'the_professor'">
      <path d="M16 7 L28 12 L16 17 L4 12 Z" />
      <path d="M9 14.5 V19 C9 21 12 23 16 23 C20 23 23 21 23 19 V14.5" />
      <path d="M26 13 V19.5" />
      <circle cx="26" cy="21" r="1.2" fill="currentColor" stroke="none" />
    </g>

    <!-- Momentum Surfer — rider cresting an ascending wave -->
    <g v-else-if="profileId === 'momentum_surfer'">
      <path d="M2 24 C6 24 8 16 14 16 C20 16 22 22 26 22 L30 22" />
      <path d="M9 14 L17 14" />
      <circle cx="13" cy="9.5" r="1.8" fill="currentColor" stroke="none" />
      <path d="M13 11.3 L13 14" />
      <path d="M11 12 L15 12" />
    </g>

    <!-- Contrarian Chad — opposing flows -->
    <g v-else-if="profileId === 'contrarian_chad'">
      <path d="M5 11 L27 11" />
      <path d="M22 6 L27 11 L22 16" />
      <path d="M27 21 L5 21" />
      <path d="M10 26 L5 21 L10 16" />
    </g>

    <!-- Joker — three-pointed jester hat with face -->
    <g v-else-if="profileId === 'joker'" transform="scale(1.3333)">
      <path d="M12 9C12 9 14 3 19 4C19 4 18 8 15 10" />
      <path d="M12 9C12 9 10 3 5 4C5 4 6 8 9 10" />
      <path d="M12 9V4" />
      <circle cx="19" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="3" r="1" fill="currentColor" stroke="none" />
      <path d="M7 14C7 14 9 12 12 12C15 12 17 14 17 14C17 14 16 19 12 19C8 19 7 14 7 14Z" />
      <path d="M9 15C10 16.5 14 16.5 15 15" :stroke-width="1 / 1.3333" />
    </g>

    <!-- Drunk Uncle — tilted beer mug with foam -->
    <g v-else-if="profileId === 'drunk_uncle'" transform="rotate(-8 16 16)">
      <path d="M9 12 L10 27 L20 27 L21 12 Z" />
      <path d="M21 14 L24 14 L24 21 L21 21" />
      <path d="M9 12 C10 9.5 12 9 14 10 C16 8 19 9 20 11 C20.2 11.4 20.6 11.8 21 12" />
      <circle cx="12" cy="9.8" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="17" cy="8.5" r="0.7" fill="currentColor" stroke="none" />
      <path d="M12 18 L18 18" opacity="0.45" />
      <path d="M12 22 L18 22" opacity="0.45" />
    </g>

    <!-- Venture Mode — minimal rocket -->
    <g v-else-if="profileId === 'venture_mode'">
      <path d="M16 3 C19 7 20 12 20 18 V22 H12 V18 C12 12 13 7 16 3 Z" />
      <circle cx="16" cy="13" r="2" />
      <path d="M12 18 L8 23 L12 22" />
      <path d="M20 18 L24 23 L20 22" />
      <path d="M14 24 L16 28 L18 24" />
    </g>

    <!-- Risk Officer — shield with check -->
    <g v-else-if="profileId === 'risk_officer'">
      <path d="M16 3 L5 7 V15 C5 21.5 10 26 16 28 C22 26 27 21.5 27 15 V7 Z" />
      <path d="M11 16 L14.5 19.5 L21 13" />
    </g>

    <!-- Passive Index — flat bar chart with baseline trend -->
    <g v-else-if="profileId === 'passive_index'">
      <path d="M4 5 V27" />
      <path d="M4 27 L28 27" />
      <rect x="8" y="19" width="4" height="8" />
      <rect x="14" y="13" width="4" height="14" />
      <rect x="20" y="16" width="4" height="11" />
      <path d="M8 10 L14 7 L20 11 L24 9" opacity="0.5" />
    </g>

    <!-- Active Hedge — tipped balance scale -->
    <g v-else-if="profileId === 'active_hedge'">
      <path d="M16 5 V27" />
      <path d="M11 27 L21 27" />
      <circle cx="16" cy="5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M6 9 L26 13" />
      <path d="M6 9 L3 15 L9 15 Z" />
      <path d="M26 13 L23 21 L29 21 Z" />
    </g>

    <!-- Fallback — neutral circle node -->
    <g v-else>
      <circle cx="16" cy="16" r="10" />
      <circle cx="16" cy="16" r="2" fill="currentColor" stroke="none" />
    </g>
  </svg>
</template>

<style scoped>
.picon {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
