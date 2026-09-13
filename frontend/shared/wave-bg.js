// Big, bold, forward-rolling ASCII wave background.
// Usage: initWaveBackground('wave') where 'wave' is a <canvas id="wave">.
function initWaveBackground(canvasId){
  const canvas = document.getElementById(canvasId);
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CHARS = " .`,:;-~+xX#%$@";
  const cell = 15;
  let cols, rows, W, H, dpr;

  function resize(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
    cols = Math.ceil(W / cell) + 1;
    rows = Math.ceil(H / cell) + 1;
    ctx.font = (cell*0.98) + "px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textBaseline = 'top';
  }
  resize();
  window.addEventListener('resize', resize);

  function emberColor(t, a){
    if(t > 0.86){
      const k = (t - 0.86) / 0.14;
      const r = Math.round(255 - k*15);
      const g = Math.round(52 + k*70);
      const b = Math.round(42 + k*70);
      return `rgba(${r},${g},${b},${a})`;
    }
    const r = Math.round(130 + t*125);
    const g = Math.round(16 + t*36);
    const b = Math.round(14 + t*24);
    return `rgba(${r},${g},${b},${a})`;
  }

  const WAVE_COUNT = 4;
  const waves = Array.from({length: WAVE_COUNT}, (_, i) => ({
    phase: i / WAVE_COUNT,
    speed: 0.034 + (i % 3) * 0.006,
    freq: 0.0075 + i * 0.0013,
    wobbleSpeed: 0.45 + i * 0.12,
    seed: i * 2.17
  }));

  let time = 0;
  const topY = -0.05;
  const bottomY = 1.2;

  function easeIn(t){ return Math.pow(t, 1.4); }

  let rafId = null;

  function draw(){
    ctx.clearRect(0,0,W,H);
    const cx = W/2;

    const active = waves.map(w => {
      const cycle = (time * w.speed + w.phase) % 1;
      const e = easeIn(cycle);
      const y0 = (topY + (bottomY - topY) * e) * H;
      let opacity;
      if(cycle < 0.06) opacity = cycle / 0.06;
      else if(cycle > 0.90) opacity = Math.max(0, (1 - cycle) / 0.10);
      else opacity = 1;
      return {
        ...w, cycle, y0, opacity,
        ampBase: 16 + e * 80,
        tail: 50 + e * 380,
        lookAhead: 8 + e * 18
      };
    });

    for(let cxi=0; cxi<cols; cxi++){
      const x = cxi*cell;
      const nx = (x - cx) / (W*0.5);
      const dist = Math.min(1, Math.abs(nx));
      const edgeFlare = 1 + Math.pow(dist, 1.5) * 1.9;

      const cols_w = active.map(w => {
        const amp = w.ampBase * edgeFlare;
        const wobble = Math.sin(nx*4.5 + x*w.freq + time*w.wobbleSpeed + w.seed) * amp
                     + Math.sin(x*w.freq*2.1 - time*w.wobbleSpeed*0.6 + w.seed*1.3) * amp*0.4;
        return {
          crestY: w.y0 + wobble,
          tail: w.tail * (0.55 + edgeFlare*0.35),
          lookAhead: w.lookAhead,
          opacity: w.opacity
        };
      });

      for(let ryi=0; ryi<rows; ryi++){
        const y = ryi*cell;
        let total = 0;

        for(const cw of cols_w){
          if(cw.opacity <= 0.01) continue;
          const d = cw.crestY - y;
          let val = 0;
          if(d >= 0 && d <= cw.tail){
            val = Math.pow(1 - d/cw.tail, 1.15);
          } else if(d < 0 && d >= -cw.lookAhead){
            val = (1 - (-d)/cw.lookAhead) * 0.55;
          }
          if(val <= 0) continue;
          total = Math.max(total, val * cw.opacity);
        }

        if(total < 0.045) continue;

        const flicker = 0.92 + 0.08*Math.sin(time*4 + cxi*1.1 + ryi*0.6);
        const val = Math.min(1, total * flicker);

        const charIndex = Math.min(CHARS.length-1, Math.floor(val * (CHARS.length-1) * 1.08));
        const ch = CHARS[charIndex];
        if(ch === ' ') continue;

        const alpha = Math.min(1, 0.28 + val*0.8);
        ctx.fillStyle = emberColor(val, alpha);
        ctx.fillText(ch, x, y);
      }
    }

    time += reduceMotion ? 0.006 : 0.016;
    rafId = requestAnimationFrame(draw);
  }

  draw();
}
