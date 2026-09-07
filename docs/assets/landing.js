/**
 * 跨域代理助手 · 落地页渐进增强脚本
 *
 * 设计前提：页面在完全禁用 JavaScript 时也必须可读、可导航、可滚动。
 * 因此本脚本只做四件事，且所有依赖 JS 的视觉状态都写在样式的 `html.js` 选择器下
 * （脚本加载失败不会留下空洞）：
 * 1. 截图廊的翻页按钮 / 圆点 / 自动轮播（无 JS 时仍是可横向滑动的 scroll-snap 轨道）；
 * 2. 区块滚动淡入；
 * 3. 导航当前区块高亮；
 * 4. 回顶 / 到底导轨。
 *
 * 零依赖、零外链；`prefers-reduced-motion` 下不自动轮播、不平滑滚动。
 */

(() => {
  'use strict';

  const root = document.documentElement;
  root.classList.add('js');

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** 用户声明减弱动效时，所有滚动都退化为瞬时滚动。 */
  const behavior = reduceMotion ? 'auto' : 'smooth';

  /**
   * 查询一组元素。
   * @param {string} selector 选择器
   * @returns {HTMLElement[]} 命中元素数组
   */
  const all = selector => Array.from(document.querySelectorAll(selector));

  /* ─────────────── 1. 截图廊 ─────────────── */

  const track = document.querySelector('[data-gallery-track]');

  if (track) {
    const slides = Array.from(track.children);
    const dotsBox = document.querySelector('[data-gallery-dots]');
    const bar = document.querySelector('[data-gallery-bar]');
    const prev = document.querySelector('[data-gallery-prev]');
    const next = document.querySelector('[data-gallery-next]');
    const label = dotsBox ? dotsBox.getAttribute('data-gallery-dots-label') || 'Go to slide $1' : '';
    let index = 0;
    let timer = null;
    let inView = false;

    /** 同步圆点选中态（`aria-current` 同时驱动样式与辅助技术）。 */
    const mark = () => {
      if (!dotsBox) return;
      Array.from(dotsBox.children).forEach((dot, i) =>
        dot.setAttribute('aria-current', i === index ? 'true' : 'false'),
      );
    };

    /** 停止自动轮播。 */
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    /** 开始自动轮播；减弱动效、单张截图、页面隐藏或轮播未进入视口时不启用。 */
    const start = () => {
      if (reduceMotion || slides.length < 2 || timer !== null || document.hidden || !inView) return;
      timer = setTimeout(() => {
        show(index + 1, true);
      }, 5200);
    };

    /**
     * 跳到指定截图。
     * @param {number} i 目标序号（自动环绕）
     * @param {boolean} [resume] 是否随后恢复自动轮播
     */
    function show(i, resume) {
      index = (i + slides.length) % slides.length;
      const slide = slides[index];
      if (slide) {
        const left = slide.offsetLeft - (track.clientWidth - slide.clientWidth) / 2;
        track.scrollTo({ left: Math.max(0, left), behavior });
      }
      mark();
      stop();
      if (resume) start();
    }

    if (dotsBox) {
      slides.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-current', i === 0 ? 'true' : 'false');
        dot.setAttribute('aria-label', label.replace('$1', String(i + 1)));
        dot.addEventListener('click', () => show(i, true));
        dotsBox.appendChild(dot);
      });
    }

    if (prev) prev.addEventListener('click', () => show(index - 1, true));
    if (next) next.addEventListener('click', () => show(index + 1, true));

    if (bar) {
      ['pointerenter', 'focusin'].forEach(evt => bar.addEventListener(evt, stop));
      ['pointerleave', 'focusout'].forEach(evt => bar.addEventListener(evt, start));
    }

    /* 手动滑动后用相交检测把圆点校准到当前可见截图。 */
    const galleryObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const i = slides.indexOf(entry.target);
          if (i !== -1 && i !== index) {
            index = i;
            mark();
          }
        });
      },
      { root: track, threshold: 0.6 },
    );
    slides.forEach(slide => galleryObserver.observe(slide));

    /* 自动轮播只在轮播真正在屏幕上时推进，避免用户读完一段回来发现图已翻走。 */
    const viewObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          inView = entry.isIntersecting;
          if (inView) start();
          else stop();
        });
      },
      { threshold: 0.35 },
    );
    viewObserver.observe(track);

    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  }

  /* ─────────────── 2. 滚动淡入 ─────────────── */

  const reveals = all('.reveal');

  if (!reveals.length) {
    /* nothing to enhance */
  } else if (!('IntersectionObserver' in window)) {
    reveals.forEach(el => el.classList.add('in'));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    reveals.forEach(el => revealObserver.observe(el));
  }

  /* ─────────────── 3. 导航当前区块高亮 ─────────────── */

  const navLinks = all('.site-nav > a[href^="#"]');

  if (navLinks.length && 'IntersectionObserver' in window) {
    const linkById = new Map(navLinks.map(a => [a.getAttribute('href').slice(1), a]));
    const sections = all('main section[id]').filter(section => linkById.has(section.id));
    const navObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          navLinks.forEach(a => a.removeAttribute('aria-current'));
          const link = linkById.get(entry.target.id);
          if (link) link.setAttribute('aria-current', 'true');
        });
      },
      { rootMargin: '-72px 0px -62% 0px', threshold: 0 },
    );
    sections.forEach(section => navObserver.observe(section));
  }

  /* ─────────────── 4. 回顶 / 到底导轨 ─────────────── */

  const rail = document.querySelector('.scroll-rail');

  if (rail) {
    const top = rail.querySelector('.rail-top');
    const bottom = rail.querySelector('.rail-bottom');

    const onScroll = () => {
      const y = window.scrollY || root.scrollTop || 0;
      rail.classList.toggle('at-top', y < 320);
      rail.classList.toggle('at-bottom', y + window.innerHeight >= root.scrollHeight - 90);
    };

    if (top) top.addEventListener('click', () => window.scrollTo({ top: 0, behavior }));
    if (bottom) bottom.addEventListener('click', () => window.scrollTo({ top: root.scrollHeight, behavior }));
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
  }
})();
