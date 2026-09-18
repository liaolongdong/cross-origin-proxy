/**
 * 跨域代理助手 · 落地页渐进增强脚本
 *
 * 设计前提：页面在完全禁用 JavaScript 时也必须可读、可导航、可滚动。
 * 因此本脚本只做几件事，且所有依赖 JS 的视觉状态都写在样式的 `html.js` 选择器下
 * （脚本加载失败不会留下空洞）：
 * 1. 截图廊的翻页按钮 / 圆点 / 进度条驱动的自动轮播，悬停或聚焦时暂停
 *    （无 JS 时仍是可横向滑动的 scroll-snap 轨道）；
 * 2. 区块滚动淡入，并给同一容器里的 `.reveal` 编号（`--lp-rank`），让它们依次进场；
 * 3. 导航当前区块高亮；
 * 4. 小屏汉堡菜单：把开合状态镜像到 `aria-expanded`，点选链接后收起下拉
 *    （`<details>` 本身无 JS 也能开合）；
 * 5. 回顶 / 到底导轨；
 * 6. 微信号一键复制（无 JS 时按钮不出现，号码本身是可选中的文本）；
 * 7. 页头下沿的滚动进度条，以及页头离顶后的投影（无 JS 时两者都不出现）；
 * 8. 首屏流程图的「数据包巡航」只在真正滚进视口后才放行（样式默认按住，循环动效不在没人看的地方跑）；
 * 9. 卡片的指针追光：把光斑坐标按帧写进 `--lp-x/--lp-y`，触摸设备与减弱动效下不绑定。
 *
 * 零依赖、零外链；`prefers-reduced-motion` 下不自动轮播、不平滑滚动、不错峰淡入，
 * 巡航与追光同样不启动。
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
    const gallery = track.closest('.gallery');
    const slides = Array.from(track.children);
    const dotsBox = document.querySelector('[data-gallery-dots]');
    const prev = document.querySelector('[data-gallery-prev]');
    const next = document.querySelector('[data-gallery-next]');
    const progress = document.querySelector('[data-gallery-progress]');
    const label = dotsBox ? dotsBox.getAttribute('data-gallery-dots-label') || 'Go to slide $1' : '';
    let index = 0;
    let inView = false;

    /** 自动轮播与进度条共用 `.gallery-auto` 这一条时间线：填充动画播完即翻页。 */
    const autoPossible = !reduceMotion && slides.length > 1 && Boolean(gallery && progress);

    if (autoPossible) gallery.classList.add('gallery-autoable');

    /** 同步圆点选中态（`aria-current` 同时驱动样式与辅助技术）。 */
    const mark = () => {
      if (!dotsBox) return;
      Array.from(dotsBox.children).forEach((dot, i) =>
        dot.setAttribute('aria-current', i === index ? 'true' : 'false'),
      );
    };

    /** 停止自动轮播（进度条回到空轨）。 */
    const stop = () => {
      if (gallery) gallery.classList.remove('gallery-auto');
    };

    /** 重新开始一轮自动轮播；减弱动效、页面隐藏或轮播不在视口时不启动。 */
    const start = () => {
      if (!autoPossible || document.hidden || !inView) return;
      stop();
      // 移除后强制回流，保证同一动画能立即重新触发
      void gallery.offsetWidth;
      gallery.classList.add('gallery-auto');
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

    if (progress) {
      progress.addEventListener('animationend', event => {
        if (event.animationName === 'lp-gallery-auto') show(index + 1, true);
      });
    }

    /* 指针在轮播上（或焦点落在控件里）时暂停：读完当前这张之前图不会翻走。 */
    if (gallery && autoPossible) {
      ['pointerenter', 'focusin'].forEach(evt =>
        gallery.addEventListener(evt, () => gallery.classList.add('is-paused')),
      );
      ['pointerleave', 'focusout'].forEach(evt =>
        gallery.addEventListener(evt, () => gallery.classList.remove('is-paused')),
      );
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

  /* 同一个父元素里的 .reveal 依次错开：十几张卡同时淡入时，读者的眼睛跟不上
     并列的变化，排个先后「一组」才像一组。样式侧是 `calc(var(--lp-rank) * 70ms)`，
     这里只负责编号，并压到 6 档封顶，避免长网格的最后一张等太久。 */
  if (!reduceMotion) {
    const ranks = new Map();
    reveals.forEach(el => {
      const group = el.parentElement;
      const rank = ranks.has(group) ? ranks.get(group) : 0;
      ranks.set(group, rank + 1);
      el.style.setProperty('--lp-rank', String(Math.min(rank, 6)));
    });
  }

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

  /* 同一批锚点在页面上存在两簇：桌面横条 `.site-nav` 与 ≤760px 的汉堡面板
     `.nav-menu-panel`。只查前者的话，窄屏下可见的那一簇永远拿不到 `aria-current`，
     选中态等于没有——所以两簇一起收，按 id 存成「一个区块对应多份链接」。 */
  const navLinks = all('.site-nav > a[href^="#"], .nav-menu-panel a[href^="#"]');

  if (navLinks.length && 'IntersectionObserver' in window) {
    const linksById = new Map();
    navLinks.forEach(a => {
      const id = a.getAttribute('href').slice(1);
      if (!linksById.has(id)) linksById.set(id, []);
      linksById.get(id).push(a);
    });
    const sections = all('main section[id]').filter(section => linksById.has(section.id));
    const navObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          navLinks.forEach(a => a.removeAttribute('aria-current'));
          (linksById.get(entry.target.id) || []).forEach(a => a.setAttribute('aria-current', 'true'));
        });
      },
      { rootMargin: '-72px 0px -62% 0px', threshold: 0 },
    );
    sections.forEach(section => navObserver.observe(section));
  }

  /* ─────────────── 4. 小屏汉堡菜单：展开状态与点选后收起 ─────────────── */

  const navMenu = document.querySelector('.nav-menu');

  if (navMenu) {
    const summary = navMenu.querySelector('summary');

    /* `<details>` 的开合状态辅助技术读得到，但面板现在带进场动画，
       显式声明 `aria-expanded` 让「按钮控制的是哪块内容」说得更清楚。 */
    const syncExpanded = () => {
      if (summary) summary.setAttribute('aria-expanded', String(navMenu.open));
    };

    navMenu.addEventListener('toggle', syncExpanded);
    navMenu.addEventListener('click', event => {
      if (event.target.closest('a')) navMenu.removeAttribute('open');
    });
    syncExpanded();
  }

  /* ─────────────── 5. 回顶 / 到底导轨 ─────────────── */

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

  /* ─────────────── 6. 微信号一键复制 ─────────────── */

  all('[data-copy]').forEach(btn => {
    const text = btn.getAttribute('data-copy');
    const okMsg = btn.getAttribute('data-copied') || 'Copied';
    const errMsg = btn.getAttribute('data-copy-failed') || 'Copy failed';
    const status = btn.parentElement ? btn.parentElement.querySelector('.copy-status') : null;
    let timer = null;

    /** 结果写在 `role="status"` 区域：按钮文字变化不一定会被辅助技术播报，这个区域会。 */
    const report = (message, ok) => {
      if (status) {
        status.textContent = message;
        status.classList.toggle('is-failed', !ok);
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (status) status.textContent = '';
        timer = null;
      }, 4000);
    };

    /** 兜底路径：非安全上下文与旧浏览器只有 execCommand 能写剪贴板，用完即删。 */
    const legacyCopy = () => {
      const box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.position = 'fixed';
      box.style.top = '-40px';
      box.style.opacity = '0';
      document.body.appendChild(box);
      box.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        // 视口外的临时 textarea 被拒绝时按复制失败处理，交给下面的提示文案
      }
      box.remove();
      return copied;
    };

    btn.addEventListener('click', async () => {
      if (!text) return;
      let copied = false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          // 权限或焦点受限时 writeText 会 reject，落到下面的 execCommand 兜底
        }
      }
      if (!copied) copied = legacyCopy();
      report(copied ? okMsg : errMsg, copied);
    });
  });

  /* ─────────────── 7. 页头进度条与离顶投影 ─────────────── */

  const header = document.querySelector('.site-header');
  const scrollBar = document.querySelector('.scroll-progress i');

  if (header || scrollBar) {
    /**
     * 进度条改 `transform` 而不是 `width`：进度更新只走合成器，不触发重排。
     * 投影用 4px 死区，避免页面在亚像素滚动时来回擦边。
     */
    const onScroll = () => {
      const y = window.scrollY || root.scrollTop || 0;
      if (scrollBar) {
        const scrollable = root.scrollHeight - window.innerHeight;
        const ratio = scrollable > 0 ? y / scrollable : 0;
        scrollBar.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
      }
      if (header) header.classList.toggle('is-scrolled', y > 4);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
  }

  /* ─────────────── 8. 首屏流程图：滚进视口才巡航 ─────────────── */

  const flow = document.querySelector('.hero-visual .flow');

  /* 循环动效在视口外照样逐帧跑，所以样式默认按住（`html.js` 下的
     `animation-play-state: paused`），由这里加上 `.is-live` 才放行。
     减弱动效下样式已把动画关掉，连观察器都不必建。 */
  if (flow && !reduceMotion) {
    if (!('IntersectionObserver' in window)) flow.classList.add('is-live');
    else {
      const flowObserver = new IntersectionObserver(
        entries => {
          entries.forEach(entry => flow.classList.toggle('is-live', entry.isIntersecting));
        },
        { threshold: 0.3 },
      );
      flowObserver.observe(flow);
    }
  }

  /* ─────────────── 9. 卡片指针追光 ─────────────── */

  /* 光斑坐标交给样式的 `radial-gradient(... at var(--lp-x) var(--lp-y))`，脚本只写两个
     自定义属性，不碰 DOM 结构。指针事件可以比帧率更密，因此一帧只落地一次：
     最新一次位置攒进 `pending`，交给 `requestAnimationFrame` 里的 paint 统一写入。
     触摸设备没有悬停态，也就没有可跟的光源，直接不绑定。 */
  const grids = all('.feature-grid, .tools-grid');

  if (grids.length && !reduceMotion && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    let frame = null;
    let pending = null;

    const paint = () => {
      frame = null;
      if (!pending) return;
      const { card, x, y } = pending;
      pending = null;
      card.style.setProperty('--lp-x', `${x}%`);
      card.style.setProperty('--lp-y', `${y}%`);
    };

    grids.forEach(grid =>
      grid.addEventListener(
        'pointermove',
        event => {
          const card = event.target.closest('.feature-card, .tool-card');
          if (!card) return;
          const box = card.getBoundingClientRect();
          if (!box.width || !box.height) return;
          pending = {
            card,
            x: ((event.clientX - box.left) / box.width) * 100,
            y: ((event.clientY - box.top) / box.height) * 100,
          };
          if (frame === null) frame = requestAnimationFrame(paint);
        },
        { passive: true },
      ),
    );
  }
})();
