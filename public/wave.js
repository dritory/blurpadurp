// Fire the Subscribe letter-wave at most once per 10s, tracked in
// sessionStorage so server-rendered page transitions don't retrigger
// it on every click. See styles.ts for the keyframe + staggered
// animation-delay.
(function () {
  try {
    var k = "blurp_last_wave";
    var n = Date.now();
    var l = Number(sessionStorage.getItem(k) || 0);
    if (n - l >= 10000) {
      var a = document.querySelector('a[href="/subscribe"]');
      if (a) {
        a.classList.add("waving");
        sessionStorage.setItem(k, String(n));
        setTimeout(function () {
          a.classList.remove("waving");
        }, 1800);
      }
    }
  } catch (e) {
    /* no-op */
  }
})();
