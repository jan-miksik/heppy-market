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
</script>

<template>
  <div class="behavior-form">
    <template v-if="type === 'agent'">
      <div class="behavior-section">
        <div class="behavior-section__title">Risk Personality</div>
        <div class="form-row">
          <label>Risk Appetite</label>
          <select :value="modelValue.riskAppetite" :disabled="readonly" @change="update('riskAppetite', ($event.target as HTMLSelectElement).value)">
            <option value="conservative">Conservative</option>
            <option value="moderate">Moderate</option>
            <option value="aggressive">Aggressive</option>
            <option value="degen">Degen</option>
          </select>
        </div>
        <div class="form-row">
          <label>FOMO Prone <span class="value-badge">{{ modelValue.fomoProne }}</span></label>
          <input type="range" min="0" max="100" :value="modelValue.fomoProne" :disabled="readonly" @input="update('fomoProne', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Panic Sell Threshold <span class="value-badge">{{ modelValue.panicSellThreshold }}</span></label>
          <input type="range" min="0" max="100" :value="modelValue.panicSellThreshold" :disabled="readonly" @input="update('panicSellThreshold', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Contrarian <span class="value-badge">{{ modelValue.contrarian }}</span></label>
          <input type="range" min="0" max="100" :value="modelValue.contrarian" :disabled="readonly" @input="update('contrarian', Number(($event.target as HTMLInputElement).value))" />
        </div>
      </div>

      <div class="behavior-section">
        <div class="behavior-section__title">Decision Style</div>
        <div class="form-row">
          <label>Analysis Depth</label>
          <select :value="modelValue.analysisDepth" :disabled="readonly" @change="update('analysisDepth', ($event.target as HTMLSelectElement).value)">
            <option value="quick">Quick</option>
            <option value="balanced">Balanced</option>
            <option value="thorough">Thorough</option>
          </select>
        </div>
        <div class="form-row">
          <label>Decision Speed</label>
          <select :value="modelValue.decisionSpeed" :disabled="readonly" @change="update('decisionSpeed', ($event.target as HTMLSelectElement).value)">
            <option value="impulsive">Impulsive</option>
            <option value="measured">Measured</option>
            <option value="patient">Patient</option>
          </select>
        </div>
        <div class="form-row">
          <label>Confidence Threshold <span class="value-badge">{{ modelValue.confidenceThreshold }}%</span></label>
          <input type="range" min="0" max="100" :value="modelValue.confidenceThreshold" :disabled="readonly" @input="update('confidenceThreshold', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row form-row--checkbox">
          <label>Overthinker</label>
          <input type="checkbox" :checked="!!modelValue.overthinker" :disabled="readonly" @change="update('overthinker', ($event.target as HTMLInputElement).checked)" />
        </div>
      </div>

      <div class="behavior-section">
        <div class="behavior-section__title">Trading Philosophy</div>
        <div class="form-row">
          <label>Style</label>
          <select :value="modelValue.style" :disabled="readonly" @change="update('style', ($event.target as HTMLSelectElement).value)">
            <option value="scalper">Scalper</option>
            <option value="swing">Swing</option>
            <option value="position">Position</option>
            <option value="hybrid">Hybrid</option>
          </select>
        </div>
        <div class="form-row">
          <label>Preferred Conditions</label>
          <select :value="modelValue.preferredConditions" :disabled="readonly" @change="update('preferredConditions', ($event.target as HTMLSelectElement).value)">
            <option value="trending">Trending</option>
            <option value="ranging">Ranging</option>
            <option value="volatile">Volatile</option>
            <option value="any">Any</option>
          </select>
        </div>
        <div class="form-row">
          <label>Entry Preference</label>
          <select :value="modelValue.entryPreference" :disabled="readonly" @change="update('entryPreference', ($event.target as HTMLSelectElement).value)">
            <option value="breakout">Breakout</option>
            <option value="pullback">Pullback</option>
            <option value="dip_buy">Dip Buy</option>
            <option value="momentum">Momentum</option>
          </select>
        </div>
        <div class="form-row">
          <label>Exit Strategy</label>
          <select :value="modelValue.exitStrategy" :disabled="readonly" @change="update('exitStrategy', ($event.target as HTMLSelectElement).value)">
            <option value="tight_stops">Tight Stops</option>
            <option value="trailing">Trailing</option>
            <option value="time_based">Time Based</option>
            <option value="signal_based">Signal Based</option>
          </select>
        </div>
        <div class="form-row form-row--checkbox">
          <label>Average Down</label>
          <input type="checkbox" :checked="!!modelValue.averageDown" :disabled="readonly" @change="update('averageDown', ($event.target as HTMLInputElement).checked)" />
        </div>
      </div>

      <div class="behavior-section">
        <div class="behavior-section__title">Communication & Logging</div>
        <div class="form-row">
          <label>Verbosity</label>
          <select :value="modelValue.verbosity" :disabled="readonly" @change="update('verbosity', ($event.target as HTMLSelectElement).value)">
            <option value="minimal">Minimal</option>
            <option value="normal">Normal</option>
            <option value="detailed">Detailed</option>
            <option value="stream_of_consciousness">Stream of Consciousness</option>
          </select>
        </div>
        <div class="form-row">
          <label>Personality</label>
          <select :value="modelValue.personality" :disabled="readonly" @change="update('personality', ($event.target as HTMLSelectElement).value)">
            <option value="professional">Professional</option>
            <option value="casual">Casual</option>
            <option value="meme_lord">Meme Lord</option>
            <option value="academic">Academic</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="form-row form-row--checkbox">
          <label>Emotional Awareness</label>
          <input type="checkbox" :checked="!!modelValue.emotionalAwareness" :disabled="readonly" @change="update('emotionalAwareness', ($event.target as HTMLInputElement).checked)" />
        </div>
      </div>

      <div class="behavior-section">
        <div class="behavior-section__title">Market Outlook</div>
        <div class="form-row">
          <label>Default Bias</label>
          <select :value="modelValue.defaultBias" :disabled="readonly" @change="update('defaultBias', ($event.target as HTMLSelectElement).value)">
            <option value="bullish">Bullish</option>
            <option value="bearish">Bearish</option>
            <option value="neutral">Neutral</option>
          </select>
        </div>
        <div class="form-row">
          <label>Adaptability <span class="value-badge">{{ modelValue.adaptability }}</span></label>
          <input type="range" min="0" max="100" :value="modelValue.adaptability" :disabled="readonly" @input="update('adaptability', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Memory Weight</label>
          <select :value="modelValue.memoryWeight" :disabled="readonly" @change="update('memoryWeight', ($event.target as HTMLSelectElement).value)">
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="long">Long</option>
          </select>
        </div>
      </div>
    </template>

    <template v-else-if="type === 'manager'">
      <div class="behavior-section">
        <div class="behavior-section__title">Management Settings</div>
        <div class="form-row">
          <label>Management Style</label>
          <select :value="modelValue.managementStyle" :disabled="readonly" @change="update('managementStyle', ($event.target as HTMLSelectElement).value)">
            <option value="hands_off">Hands Off</option>
            <option value="balanced">Balanced</option>
            <option value="micromanager">Micromanager</option>
          </select>
        </div>
        <div class="form-row">
          <label>Risk Tolerance</label>
          <select :value="modelValue.riskTolerance" :disabled="readonly" @change="update('riskTolerance', ($event.target as HTMLSelectElement).value)">
            <option value="conservative">Conservative</option>
            <option value="moderate">Moderate</option>
            <option value="aggressive">Aggressive</option>
          </select>
        </div>
        <div class="form-row">
          <label>Diversification</label>
          <select :value="modelValue.diversificationPreference" :disabled="readonly" @change="update('diversificationPreference', ($event.target as HTMLSelectElement).value)">
            <option value="concentrated">Concentrated</option>
            <option value="balanced">Balanced</option>
            <option value="diversified">Diversified</option>
          </select>
        </div>
        <div class="form-row">
          <label>Performance Patience <span class="value-badge">{{ modelValue.performancePatience }}</span></label>
          <input type="range" min="0" max="100" :value="modelValue.performancePatience" :disabled="readonly" @input="update('performancePatience', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Creation Aggressiveness <span class="value-badge">{{ modelValue.creationAggressiveness }}</span></label>
          <input type="range" min="0" max="100" :value="modelValue.creationAggressiveness" :disabled="readonly" @input="update('creationAggressiveness', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Rebalance Frequency</label>
          <select :value="modelValue.rebalanceFrequency" :disabled="readonly" @change="update('rebalanceFrequency', ($event.target as HTMLSelectElement).value)">
            <option value="rarely">Rarely</option>
            <option value="sometimes">Sometimes</option>
            <option value="often">Often</option>
          </select>
        </div>
        <div class="form-row">
          <label>Philosophy Bias</label>
          <select :value="modelValue.philosophyBias" :disabled="readonly" @change="update('philosophyBias', ($event.target as HTMLSelectElement).value)">
            <option value="trend_following">Trend Following</option>
            <option value="mean_reversion">Mean Reversion</option>
            <option value="mixed">Mixed</option>
          </select>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.behavior-form { display: flex; flex-direction: column; gap: 20px; }
.behavior-section { border: 1px solid var(--border, #2a2a2a); border-radius: 8px; padding: 16px; }
.behavior-section__title { font-weight: 600; font-size: 13px; color: var(--text-secondary, #888); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
.form-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--border, #2a2a2a) 50%, transparent); }
.form-row:last-child { border-bottom: none; }
.form-row label { font-size: 13px; color: var(--text, #e0e0e0); flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.form-row select, .form-row input[type="range"] { flex: 1; max-width: 200px; }
.form-row--checkbox { justify-content: flex-start; gap: 12px; }
.value-badge { background: var(--tag-bg, #1e1e1e); border: 1px solid var(--border, #2a2a2a); border-radius: 4px; padding: 1px 6px; font-size: 11px; color: var(--accent, #7c6af7); font-weight: 600; }
</style>
