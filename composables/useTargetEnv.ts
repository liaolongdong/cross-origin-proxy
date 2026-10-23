import { computed, reactive, ref } from 'vue';
import { apiOriginOf } from '@/utils/pageApiOrigins';

/**
 * 「目标环境」那一格的判据（导入弹窗里每个「一键生成规则」的进口共用一份）
 *
 * 为什么必须收在一处：这一格最容易坏的地方是**看不见的那半**——界面上那个「导入后立即启用」
 * 复选框只在读得出合法 origin 时出现，于是「它没出现」必须等价于「用户没勾」，否则清掉目标之后
 * 一个看不见的复选框还在替用户决定这批规则要不要当场生效（那是把整站流量指走的后果）。
 * 第二条进口（OpenAPI / Swagger）出现时，这条不变量不该被再实现一遍。
 *
 * 判据本身不在这：`apiOriginOf` 才决定「什么算一个环境」（只取协议 + 域名 + 端口，
 * 粘贴整条 URL 也一样；读不出 http(s) 就返回空串）。这里只管那一格的四种状态。
 *
 * 返回的是 `reactive`，不是「一堆 ref 装在普通对象里」：模板只会自动解开**顶层**的 ref，
 * `harTarget.raw` 这种嵌套写法解开不了，`v-model` 会直接收到一个 Ref 并在类型上就报错。
 */
export function useTargetEnv() {
  /** 用户敲进去的原样（合法时会被 `normalize` 收成 origin） */
  const raw = ref('');
  /** 复选框本身的勾选态；它不出现时不参与决策，见 `enableOnImportFlag` */
  const enableOnImport = ref(true);

  /** 读得出的目标 origin；空串 = 这一格等于没填（computed 有缓存，四个状态共用这一次解析） */
  const parsed = computed(() => apiOriginOf(raw.value.trim()));
  const valid = computed(() => !!parsed.value);

  return reactive({
    raw,
    enableOnImport,
    parsed,
    valid,
    /** 填了但读不出 http(s)：只在「有内容且不合法」时为真，空着不算错 */
    invalid: computed(() => !!raw.value.trim() && !valid.value),
    /** 交给生成规则那一侧的最终参与：复选框没出现一律按未勾 */
    enableOnImportFlag: computed(() => valid.value && enableOnImport.value),

    /** 失焦时把整条 URL 收成 origin，让用户看见自己实际填进去的是什么 */
    normalize(): void {
      if (valid.value) raw.value = parsed.value;
    },

    reset(): void {
      raw.value = '';
      enableOnImport.value = true;
    },
  });
}
