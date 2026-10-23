<template>
  <div
    class="table-skeleton"
    role="status"
    :aria-label="label"
  >
    <div
      v-for="row in rows"
      :key="row"
      class="skeleton-row"
      aria-hidden="true"
    >
      <span
        v-for="(column, index) in columns"
        :key="index"
        class="skeleton-box"
        :style="{ width: column.width, flex: column.flex }"
      ></span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 读取还在路上时占住表格那一块的骨架
 *
 * 存在的理由不是「好看」，而是**不替用户下结论**：首屏那一次往返还没落定之前，
 * 表格手上既没有内容、也没有失败，此时画空态引导卡就是说「你一条规则都没有」，
 * 画「暂无请求记录」就是说「一条记录都没产生过」——两句都可能在半秒后被自己的数据推翻。
 * 骨架只说眼前这一件事实：还没读到。
 *
 * 它同时不会一直挂着：两个使用方都把它排在「读取失败」那一格**之前**、用同一个
 * `loading && !everRead` 判据，而 `loading` 在失败时同样落回 false，于是第一次就读失败
 * 立刻换成失败那一格。「读不到」不许画成「还在加载」——这是本仓「读不到 ≠ 没有」那条规矩的反方向。
 *
 * 两处共用一份，是因为同一次冷启动里规则表和日志抽屉各自要首屏拉一次：两处各写一套骨架，
 * 那道光的节拍就可能不一样（`--cop-duration-sheen` 说好了只有一个数）。
 */

defineProps<{
  /** 读屏要念的那一句：这一屏在等什么 */
  label: string;
  /**
   * 画哪几格。固定列给 `width`，能伸缩的列给 `flex`——两个都不给就是一格 0 宽，等于没画。
   * 列数按「这一屏的轮廓」取，不要求和真实表格逐列对齐：骨架要交代的是「一会儿这儿是一张表」。
   */
  columns: { width?: string; flex?: number }[];
  /**
   * 画几行
   *
   * 与真实行数无关（此刻手上根本没有行数），取的是「不至于让人以为表是空的、
   * 又不会在读完换成三五行时往下跳一大截」的中间值。
   */
  rows: number;
}>();
</script>

<style scoped>
.table-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 4px;
}

.skeleton-row {
  display: flex;
  gap: 16px;
  align-items: center;
  height: 40px;
}

/* 本底与那道光取主色通道的两个浓度——暗色档由通道自己跟着主题换，这里不需要第二套值。
   `background-size: 200% 100%` 是令牌层 `cop-skeleton-sheen` 的前提：它把 `background-position`
   从 150% 推到 -50%，本底不满 200% 宽就扫不过去（漏了那一行，表现是光斑整个不动，且没有任何报错）。 */
.skeleton-box {
  flex-shrink: 0;
  height: 12px;
  background-image: linear-gradient(
    90deg,
    rgb(var(--cop-primary-rgb) / 8%) 0%,
    rgb(var(--cop-primary-rgb) / 18%) 50%,
    rgb(var(--cop-primary-rgb) / 8%) 100%
  );
  background-size: 200% 100%;
  border-radius: 4px;
  animation: cop-skeleton-sheen var(--cop-duration-sheen) var(--cop-ease-standard) infinite;
}
</style>
