import { createAndMountApp } from '@/utils/createVueApp';
import App from './App.vue';
// ElMessage 为显式导入（非自动解析），按需样式需手动补齐
import 'element-plus/es/components/message/style/css';
import '@/assets/theme/tokens.css';
import { initThemeSync } from '@/utils/theme';
import { initLocaleSync, t } from '@/utils/i18n';

initThemeSync();
initLocaleSync();

// 页面标题走自研 i18n（随应用内语言，而非浏览器语言）
document.title = t('popupTitle');

createAndMountApp(App);
