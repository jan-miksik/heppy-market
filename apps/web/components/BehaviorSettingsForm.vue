<script setup lang="ts">
const props = defineProps<{
  modelValue: Record<string, unknown>;
  type: 'agent' | 'manager';
  readonly?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [v: Record<string, unknown>] }>();

function update(key: string, value: unknown) {
  if (props.readonly) return;
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

// Button group helper
function isActive(key: string, val: unknown) {
  return props.modelValue[key] === val;
}
</script>

<template>
  <div class="bsf">
    <!-- ── AGENT ───────────────────────────────────── -->
    <template v-if="type === 'agent'">

      <!-- Risk -->
      <div class="bsf__section">
        <div class="bsf__head">Risk Personality</div>

        <div class="bsf__row">
          <span class="bsf__label">Risk Appetite</span>
          <div class="bsf__seg">
            <button v-for="opt in ['conservative','moderate','aggressive','degen']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('riskAppetite', opt) }]"
              :disabled="readonly" @click="update('riskAppetite', opt)">
              {{ opt }}
            </button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">FOMO Prone <em>{{ modelValue.fomoProne }}</em></span>
          <input type="range" min="0" max="100" class="bsf__range"
            :value="modelValue.fomoProne" :disabled="readonly"
            @input="update('fomoProne', Number(($event.target as HTMLInputElement).value))" />
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Panic Sell <em>{{ modelValue.panicSellThreshold }}</em></span>
          <input type="range" min="0" max="100" class="bsf__range"
            :value="modelValue.panicSellThreshold" :disabled="readonly"
            @input="update('panicSellThreshold', Number(($event.target as HTMLInputElement).value))" />
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Contrarian <em>{{ modelValue.contrarian }}</em></span>
          <input type="range" min="0" max="100" class="bsf__range"
            :value="modelValue.contrarian" :disabled="readonly"
            @input="update('contrarian', Number(($event.target as HTMLInputElement).value))" />
        </div>
      </div>

      <!-- Decision Style -->
      <div class="bsf__section">
        <div class="bsf__head">Decision Style</div>

        <div class="bsf__row">
          <span class="bsf__label">Analysis Depth</span>
          <div class="bsf__seg">
            <button v-for="opt in ['quick','balanced','thorough']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('analysisDepth', opt) }]"
              :disabled="readonly" @click="update('analysisDepth', opt)">{{ opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Decision Speed</span>
          <div class="bsf__seg">
            <button v-for="opt in ['impulsive','measured','patient']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('decisionSpeed', opt) }]"
              :disabled="readonly" @click="update('decisionSpeed', opt)">{{ opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Confidence Min <em>{{ modelValue.confidenceThreshold }}%</em></span>
          <input type="range" min="0" max="100" class="bsf__range"
            :value="modelValue.confidenceThreshold" :disabled="readonly"
            @input="update('confidenceThreshold', Number(($event.target as HTMLInputElement).value))" />
        </div>

        <div class="bsf__row bsf__row--check">
          <span class="bsf__label">Overthinker</span>
          <label class="bsf__toggle">
            <input type="checkbox" :checked="!!modelValue.overthinker" :disabled="readonly"
              @change="update('overthinker', ($event.target as HTMLInputElement).checked)" />
            <span class="bsf__toggle-track"><span class="bsf__toggle-thumb" /></span>
          </label>
        </div>
      </div>

      <!-- Trading Philosophy -->
      <div class="bsf__section">
        <div class="bsf__head">Trading Philosophy</div>

        <div class="bsf__row">
          <span class="bsf__label">Style</span>
          <div class="bsf__seg">
            <button v-for="opt in ['scalper','swing','position','hybrid']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('style', opt) }]"
              :disabled="readonly" @click="update('style', opt)">{{ opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Conditions</span>
          <div class="bsf__seg">
            <button v-for="opt in ['trending','ranging','volatile','any']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('preferredConditions', opt) }]"
              :disabled="readonly" @click="update('preferredConditions', opt)">{{ opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Entry</span>
          <div class="bsf__seg">
            <button v-for="opt in ['breakout','pullback','dip_buy','momentum']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('entryPreference', opt) }]"
              :disabled="readonly" @click="update('entryPreference', opt)">{{ opt.replace('_',' ') }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Exit</span>
          <div class="bsf__seg">
            <button v-for="opt in ['tight_stops','trailing','time_based','signal_based']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('exitStrategy', opt) }]"
              :disabled="readonly" @click="update('exitStrategy', opt)">{{ opt.replace('_',' ') }}</button>
          </div>
        </div>

        <div class="bsf__row bsf__row--check">
          <span class="bsf__label">Average Down</span>
          <label class="bsf__toggle">
            <input type="checkbox" :checked="!!modelValue.averageDown" :disabled="readonly"
              @change="update('averageDown', ($event.target as HTMLInputElement).checked)" />
            <span class="bsf__toggle-track"><span class="bsf__toggle-thumb" /></span>
          </label>
        </div>
      </div>

      <!-- Communication -->
      <div class="bsf__section">
        <div class="bsf__head">Communication</div>

        <div class="bsf__row">
          <span class="bsf__label">Verbosity</span>
          <div class="bsf__seg">
            <button v-for="opt in ['minimal','normal','detailed','stream_of_consciousness']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('verbosity', opt) }]"
              :disabled="readonly" @click="update('verbosity', opt)">{{ opt === 'stream_of_consciousness' ? 'stream' : opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Personality</span>
          <div class="bsf__seg">
            <button v-for="opt in ['professional','casual','meme_lord','academic','custom']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('personality', opt) }]"
              :disabled="readonly" @click="update('personality', opt)">{{ opt.replace('_',' ') }}</button>
          </div>
        </div>

        <div class="bsf__row bsf__row--check">
          <span class="bsf__label">Emotional Awareness</span>
          <label class="bsf__toggle">
            <input type="checkbox" :checked="!!modelValue.emotionalAwareness" :disabled="readonly"
              @change="update('emotionalAwareness', ($event.target as HTMLInputElement).checked)" />
            <span class="bsf__toggle-track"><span class="bsf__toggle-thumb" /></span>
          </label>
        </div>
      </div>

      <!-- Market Outlook -->
      <div class="bsf__section">
        <div class="bsf__head">Market Outlook</div>

        <div class="bsf__row">
          <span class="bsf__label">Default Bias</span>
          <div class="bsf__seg">
            <button v-for="opt in ['bullish','neutral','bearish']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('defaultBias', opt) }]"
              :disabled="readonly" @click="update('defaultBias', opt)">{{ opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Adaptability <em>{{ modelValue.adaptability }}</em></span>
          <input type="range" min="0" max="100" class="bsf__range"
            :value="modelValue.adaptability" :disabled="readonly"
            @input="update('adaptability', Number(($event.target as HTMLInputElement).value))" />
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Memory Weight</span>
          <div class="bsf__seg">
            <button v-for="opt in ['short','medium','long']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('memoryWeight', opt) }]"
              :disabled="readonly" @click="update('memoryWeight', opt)">{{ opt }}</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ── MANAGER ─────────────────────────────────── -->
    <template v-else-if="type === 'manager'">
      <div class="bsf__section">
        <div class="bsf__head">Management Style</div>

        <div class="bsf__row">
          <span class="bsf__label">Style</span>
          <div class="bsf__seg">
            <button v-for="opt in ['hands_off','balanced','micromanager']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('managementStyle', opt) }]"
              :disabled="readonly" @click="update('managementStyle', opt)">{{ opt.replace('_',' ') }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Risk Tolerance</span>
          <div class="bsf__seg">
            <button v-for="opt in ['conservative','moderate','aggressive']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('riskTolerance', opt) }]"
              :disabled="readonly" @click="update('riskTolerance', opt)">{{ opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Diversification</span>
          <div class="bsf__seg">
            <button v-for="opt in ['concentrated','balanced','diversified']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('diversificationPreference', opt) }]"
              :disabled="readonly" @click="update('diversificationPreference', opt)">{{ opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Perf. Patience <em>{{ modelValue.performancePatience }}</em></span>
          <input type="range" min="0" max="100" class="bsf__range"
            :value="modelValue.performancePatience" :disabled="readonly"
            @input="update('performancePatience', Number(($event.target as HTMLInputElement).value))" />
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Creation Aggr. <em>{{ modelValue.creationAggressiveness }}</em></span>
          <input type="range" min="0" max="100" class="bsf__range"
            :value="modelValue.creationAggressiveness" :disabled="readonly"
            @input="update('creationAggressiveness', Number(($event.target as HTMLInputElement).value))" />
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Rebalance</span>
          <div class="bsf__seg">
            <button v-for="opt in ['rarely','sometimes','often']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('rebalanceFrequency', opt) }]"
              :disabled="readonly" @click="update('rebalanceFrequency', opt)">{{ opt }}</button>
          </div>
        </div>

        <div class="bsf__row">
          <span class="bsf__label">Philosophy</span>
          <div class="bsf__seg">
            <button v-for="opt in ['trend_following','mean_reversion','mixed']" :key="opt"
              type="button" :class="['seg-btn', { active: isActive('philosophyBias', opt) }]"
              :disabled="readonly" @click="update('philosophyBias', opt)">{{ opt.replace('_',' ') }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bsf {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bsf__section {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  overflow: hidden;
}

.bsf__head {
  padding: 8px 14px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
  background: color-mix(in srgb, var(--border, #2a2a2a) 40%, transparent);
  border-bottom: 1px solid var(--border, #2a2a2a);
}

.bsf__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--border, #2a2a2a) 60%, transparent);
}
.bsf__row:last-child { border-bottom: none; }

.bsf__label {
  font-size: 12px;
  color: var(--text-secondary, #888);
  flex-shrink: 0;
  min-width: 120px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bsf__label em {
  font-style: normal;
  color: var(--accent, #7c6af7);
  font-weight: 600;
  font-size: 11px;
  background: color-mix(in srgb, var(--accent, #7c6af7) 12%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
}

/* Segment control */
.bsf__seg {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.seg-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--border, #2a2a2a);
  background: transparent;
  color: var(--text-secondary, #888);
  cursor: pointer;
  transition: all 0.12s;
  text-transform: capitalize;
  white-space: nowrap;
}
.seg-btn:hover:not(:disabled) {
  border-color: var(--accent, #7c6af7);
  color: var(--text, #e0e0e0);
}
.seg-btn.active {
  background: color-mix(in srgb, var(--accent, #7c6af7) 18%, transparent);
  border-color: var(--accent, #7c6af7);
  color: var(--accent, #7c6af7);
  font-weight: 600;
}
.seg-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Range */
.bsf__range {
  flex: 1;
  max-width: 160px;
  accent-color: var(--accent, #7c6af7);
  cursor: pointer;
  height: 4px;
}

/* Toggle */
.bsf__row--check { justify-content: space-between; }
.bsf__toggle { cursor: pointer; display: flex; align-items: center; }
.bsf__toggle input { display: none; }
.bsf__toggle-track {
  width: 32px; height: 18px;
  background: var(--border, #2a2a2a);
  border-radius: 9px;
  position: relative;
  transition: background 0.2s;
}
.bsf__toggle input:checked + .bsf__toggle-track { background: var(--accent, #7c6af7); }
.bsf__toggle-thumb {
  width: 12px; height: 12px;
  background: #fff;
  border-radius: 50%;
  position: absolute;
  top: 3px; left: 3px;
  transition: transform 0.2s;
}
.bsf__toggle input:checked + .bsf__toggle-track .bsf__toggle-thumb {
  transform: translateX(14px);
}
</style>
