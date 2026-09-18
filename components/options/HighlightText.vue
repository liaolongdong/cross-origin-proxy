<template>
  <span class="highlight-text">
    <span
      v-for="(segment, index) in segments"
      :key="index"
      :class="segment.hit ? 'search-highlight' : ''"
      >{{ segment.text }}</span
    >
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { splitHighlight } from '@/utils/highlight';

/**
 * 搜索关键字高亮文本
 *
 * 只做分段渲染，不构造 HTML 字符串（分段算法见 `utils/highlight.ts`）：
 * 规则名 / URL 里的 `&<>"'` 按原样显示，搜索 `amp`、`;`、`&` 都不会打乱内容，
 * 也不再需要 `v-html`。
 */
const props = defineProps<{
  /** 待展示文本 */
  text: string;
  /** 搜索关键字，空则整段按未命中渲染 */
  keyword: string;
}>();

const segments = computed(() => splitHighlight(props.text, props.keyword));
</script>
