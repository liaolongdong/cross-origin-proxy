import { createAndMountApp } from '@/utils/createVueApp';
import App from '@/components/options/App.vue';
import 'element-plus/dist/index.css';
import '@/assets/theme/tokens.css';
import './styles.css';
import { initThemeSync } from '@/utils/theme';
import { initLocaleSync, t } from '@/utils/i18n';

initThemeSync();
initLocaleSync();

// 页面标题走自研 i18n（随应用内语言，而非浏览器语言）
document.title = t('optionsPageTitle');

createAndMountApp(App);
