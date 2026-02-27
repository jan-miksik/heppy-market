<script setup lang="ts">
import type { ProfileItem } from '~/composables/useProfiles';

const props = defineProps<{
  modelValue?: string | null;
  type: 'agent' | 'manager';
}>();

const emit = defineEmits<{
  'update:modelValue': [id: string];
  'profile-selected': [profile: ProfileItem];
}>();

const { listProfiles } = useProfiles();
const profiles = ref<ProfileItem[]>([]);
const loading = ref(true);

onMounted(async () => {
  profiles.value = await listProfiles(props.type);
  loading.value = false;
});

function selectProfile(p: ProfileItem) {
  emit('update:modelValue', p.id);
  emit('profile-selected', p);
}
</script>

<template>
  <div class="profile-picker">
    <div v-if="loading" style="text-align:center;padding:24px;"><span class="spinner" /></div>
    <div v-else class="profile-picker__grid">
      <BehaviorProfileCard
        v-for="p in profiles"
        :key="p.id"
        :profile="p"
        :selected="modelValue === p.id"
        @select="selectProfile"
      />
    </div>
  </div>
</template>

<style scoped>
.profile-picker__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
</style>
