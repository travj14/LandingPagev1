// Momentum scrolling, copied from the recap's mobile editor (web/js/mrender.js).

/**
 * Smooth, momentum-style scrolling. `amount` 0 leaves the browser alone; higher values glide
 * further and ease out more slowly. Works on the page (box = null) or on a scrolling element.
 * Self-contained so it can be copied into the exported page with toString().
 */
export function smoothScroll(box, amount) {
  var el = box || document.scrollingElement || document.documentElement;
  var host = box || window;
  var a = 0;
  var cur = 0;
  var target = 0;
  var running = false;
  var last = 0;
  var raf = 0;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var touch = { mode: null, x: 0, y: 0, lastY: 0, lastT: 0, v: 0 };
  // Fraction of the remaining distance covered per 60 Hz frame.
  function ease() {
    return 0.12 - 0.1 * a;
  }
  // Decay rate per millisecond, so a flick hands off to the glide at the same speed.
  function rate() {
    return -Math.log(1 - ease()) / 16.67;
  }
  function clamp(v) {
    return Math.max(0, Math.min(el.scrollHeight - el.clientHeight, v));
  }
  function tick(now) {
    var k = 1 - Math.pow(1 - ease(), Math.min(64, now - last) / 16.67);
    last = now;
    cur += (target - cur) * k;
    if (Math.abs(target - cur) < 0.5) {
      cur = target;
      running = false;
    }
    el.scrollTop = cur;
    if (running) raf = requestAnimationFrame(tick);
  }
  function go() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    cur = target = el.scrollTop;
  }
  function on() {
    return a > 0 && !reduce;
  }
  host.addEventListener('scroll', function () {
    if (!running) cur = target = el.scrollTop;
  }, { passive: true });
  host.addEventListener('wheel', function (e) {
    if (!on() || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    if (!running) cur = target = el.scrollTop;
    target = clamp(target + e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1));
    go();
  }, { passive: false });
  host.addEventListener('touchstart', function (e) {
    touch.mode = on() && e.touches.length === 1 ? null : 'native';
    if (touch.mode) return;
    stop();
    touch.x = e.touches[0].clientX;
    touch.y = touch.lastY = e.touches[0].clientY;
    touch.lastT = performance.now();
    touch.v = 0;
  }, { passive: true });
  host.addEventListener('touchmove', function (e) {
    if (touch.mode === 'native') return;
    var t = e.touches[0];
    if (!touch.mode) {
      var dx = Math.abs(t.clientX - touch.x);
      var dy = Math.abs(t.clientY - touch.y);
      if (dx < 4 && dy < 4) return;
      // Sideways swipes (jump menu, wide tables) keep their normal scrolling.
      touch.mode = dx > dy ? 'native' : 'drag';
      if (touch.mode === 'native') return;
    }
    e.preventDefault();
    var now = performance.now();
    var d = touch.lastY - t.clientY;
    cur = target = clamp(cur + d);
    el.scrollTop = cur;
    touch.v = 0.2 * touch.v + 0.8 * (d / Math.max(1, now - touch.lastT));
    touch.lastY = t.clientY;
    touch.lastT = now;
  }, { passive: false });
  host.addEventListener('touchend', function () {
    if (touch.mode !== 'drag') return;
    touch.mode = null;
    if (performance.now() - touch.lastT > 80) touch.v = 0;
    target = clamp(cur + touch.v / rate());
    go();
  });
  // Jump-menu links glide too.
  (box || document).addEventListener('click', function (e) {
    var link = on() && e.target.closest && e.target.closest('a[href^="#"]');
    var dest = link && link.getAttribute('href').length > 1 && document.getElementById(link.getAttribute('href').slice(1));
    if (!dest) return;
    e.preventDefault();
    if (!running) cur = el.scrollTop;
    var top = dest.getBoundingClientRect().top - (box ? box.getBoundingClientRect().top : 0);
    target = clamp(el.scrollTop + top - (parseFloat(getComputedStyle(dest).scrollMarginTop) || 0));
    go();
  });
  var api = {
    set: function (n) {
      a = Math.max(0, Math.min(1, Number(n) || 0));
    },
  };
  api.set(amount);
  return api;
}
