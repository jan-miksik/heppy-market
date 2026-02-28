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
  <div class="picker">
    <div v-if="loading" class="picker__loading">
      <span class="spinner" style="width:16px;height:16px;" />
    </div>
    <div v-else class="picker__row">
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
.picker__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.picker__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
